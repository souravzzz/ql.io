 /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

"use strict";

var filter = require('./filter.js'),
    _util = require('./util.js'),
    where = require('./where.js'),
    project = require('./project.js'),
    strTemplate = require('./peg/str-template.js'),
    _ = require('underscore'),
    async = require('async'),
    assert = require('assert');

exports.exec = function(opts, statement, parentEvent, cb) {

    assert.ok(opts.tables, 'Argument tables can not be undefined');
    assert.ok(statement, 'Argument statement can not be undefined');
    assert.ok(cb, 'Argument cb can not be undefined');
    assert.ok(opts.xformers, 'No xformers set');

    var funcs, cloned, joiningColumn, selectEvent;
    selectEvent = opts.logEmitter.wrapEvent({
        parent: parentEvent,
        txType: 'QlIoSelect',
        txName: null,
        message: {line: statement.line},
        cb: cb});

    execInternal(opts, statement, function(err, results) {
        if(err) {
            return selectEvent.cb(err, results);
        }
        if(statement.joiner) {
            // Do the join now - we fill the joining column in into the joiner statement and execute it one for each
            // row from the main's results.
            joiningColumn = statement.joiner.whereCriteria[0].rhs.joiningColumn;

            // Prepare the joins
            funcs = [];
            _.each(results.body, function(row) {
                // Clone the joiner since we are going to modify it
                cloned = clone(statement.joiner);

                // Set the join field
                cloned.whereCriteria[0].rhs.value = (_.isArray(row) || _.isObject(row)) ? row[joiningColumn] : row;

                // Determine whether the number of funcs is within the limit, otherwise break out of the loop
                var maxRequests = _util.getMaxRequests(opts.config, opts.logEmitter);
                if (funcs.length >= maxRequests) {
                    opts.logEmitter.emitWarning('Pruning the number of nested requests to config.maxNestedRequests = ' + maxRequests + '.');
                    return;
                }

                funcs.push(function(s) {
                    return function(callback) {
                        execInternal(opts, s, function(e, r) {
                            if(e) {
                                callback(e);
                            }
                            else {
                                callback(null, r.body);
                            }
                        }, selectEvent.event);
                    };
                }(cloned));
            });

            // Execute joins
            async.parallel(funcs, function(err, more) {
                // If there is nothing to loop through, leave the body undefined.
                var body = results.body ? [] : undefined;
                _.each(results.body, function(row, index) {
                    // If no matching result is found in more, skip this row
                    var other = more[index];
                    if((_.isArray(other) && other.length > 0) || (_.isObject(other) && _.keys(other) > 0)) {
                        // Results would be an array when one field is selected.
                        if(!_.isObject(row) && !_.isArray(row)) row = [row];
                        // When columns are selected by name, use an object. If not, an array.
                        var sel = statement.selected.length > 0 && statement.selected[0].name ? {} : [];
                        _.each(statement.selected, function(selected) {
                            var val = undefined;
                            if(selected.from === 'main') {
                                val = row[selected.name || selected.index];
                            }
                            else if(selected.from === 'joiner') {
                                if(other && other[0]) {
                                    if(other[0][selected.name]) {
                                        val = other[0][selected.name];
                                    }
                                    else if(_.isArray(other[0])) {
                                        val = other[0][selected.index];
                                    }
                                    else {
                                        val = other[0];
                                    }
                                }
                            }
                            if(selected.name) {
                                sel[selected.name] = val;
                            }
                            else {
                                sel.push(val);
                            }
                        });
                        body.push(sel);
                    }
                });
                results.body = body;
                if(statement.assign) {
                    opts.context[statement.assign] = results.body;
                    opts.emitter.emit(statement.assign, results.body);
                }
                return selectEvent.cb(err, results);
            });
        }
        else {
            return selectEvent.cb(err, results);
        }
    }, selectEvent.event);
};

//
// Execute a parsed select statement with no joins
function execInternal(opts, statement, cb, parentEvent) {
    var tables = opts.tables, tempResources = opts.tempResources, context = opts.context,
         request = opts.request, emitter = opts.emitter;

    var selectExecTx  = opts.logEmitter.wrapEvent({
        parent: parentEvent,
        txType: 'QlIoSelectExec',
        txName: null,
        message: {line: statement.line},
        cb: cb});
    //
    // Pre-fill columns

    var prefill = function(column) {
        // Trim the name, but keep the column alias.
        try {
            var template = strTemplate.parse(column.name);
            column.name = template.format(opts.context, true);
        }
        catch(e) {
            // Ignore
        }
        return column;
    };
    if(_.isArray(statement.columns)) {
        _.each(statement.columns, function(column, i) {
            statement.columns[i] = prefill(column);
        });
    }
    else {
        statement.columns = prefill(statement.columns);
    }

    //
    // Analyze where conditions and fetch any dependent data
    var name, params, value, r, p, max, resource, apiTx;
    where.exec(opts, statement.whereCriteria, function(err, results) {
        var i, j;
        // Now fetch each resource from left to right
        _.each(statement.fromClause, function(from) {
            // Reorder results - results is an array of objects, but we just want an object
            params = {};
            for(i = 0,max = results.length; i < max; i++) {
                r = results[i];
                for(p in r) {
                    if(r.hasOwnProperty(p)) {
                        value = r[p];
                        // Resolve alias
                        if(p.indexOf(from.alias + '.') === 0) {
                            p = p.substr(from.alias.length + 1);
                        }
                        params[p] = value;
                    }
                }
            }

            name = from.name;
            // Lookup context for the source - we do this since the compiler puts the name in
            // braces to denote the source as a variable and not a table.
            if(name.indexOf("{") === 0 && name.indexOf("}") === name.length - 1) {
                name = name.substring(1, from.name.length - 1);
            }
            resource = context[name];
            if(context.hasOwnProperty(name)) { // The value may be null/undefined, and hence the check the property
                apiTx = opts.logEmitter.wrapEvent({
                        parent: selectExecTx.event,
                        txType: 'API',
                        txName: name,
                        message: {line: statement.line},
                        cb: selectExecTx.cb});

                var filtered = filter.filter(resource, statement, context, from);

                // Project
                project.run('', statement, filtered, opts.context, function (projected) {
                    if(statement.assign) {
                        context[statement.assign] = projected;
                        emitter.emit(statement.assign, projected);
                    }
                    return apiTx.cb(null, {
                        headers: {
                            'content-type': 'application/json'
                        },
                        body: projected
                    });
                });
            }
            else {
                // Get the resource
                resource = tempResources[from.name] || tables[from.name];
                apiTx = opts.logEmitter.wrapEvent({
                        parent: selectExecTx.event,
                        txType: 'API',
                        txName: from.name,
                        message: {line: statement.line},
                        cb: selectExecTx.cb});

                if(!resource) {
                    return apiTx.cb('No such table ' + from.name);
                }
                var verb = resource.verb('select');
                if(!verb) {
                    return apiTx.cb('Table ' + from.name + ' does not support select');
                }

                // Limit and offset
                var limit = verb.aliases && verb.aliases.limit || 'limit';
                params[limit] = statement.limit;
                var offset = verb.aliases && verb.aliases.offset || 'offset';
                params[offset] = statement.offset;

                verb.exec({
                    context: opts.context,
                    config: opts.config,
                    settings: opts.settings,
                    resource: verb,
                    xformers: opts.xformers,
                    serializers: opts.serializers,
                    params: params,
                    request: request,
                    statement: statement,
                    emitter: emitter,
                    logEmitter: opts.logEmitter,
                    parentEvent: apiTx.event,
                    callback: function(err, result) {
                        if(result) {
                            context[statement.assign] = result.body;
                            emitter.emit(statement.assign, result.body);
                        }
                        return apiTx.cb(err, result);
                    },
                    cache: opts.cache
                });
            }
        });
    }, parentEvent);


    // Run tasks asynchronously and join on the callback. On completion, the results array will
}

var clone = function(obj) {
    if(obj == null || typeof(obj) != 'object') {
        return obj;
    }

    var temp = obj.constructor(); // changed

    for(var key in obj) {
        temp[key] = clone(obj[key]);
    }
    return temp;
};
