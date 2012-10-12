// Copyright 2012 Pedro P. Candel <kusorbox@gmail.com>. All rights reserved.
var util = require('util'),
    path = require('path'),
    fs = require('fs'),
    test = require('tap').test,
    uuid = require('node-uuid'),
    WorkflowRunner = require('../lib/runner'),
    Factory = require('../lib/index').Factory,
    exists = fs.exists || path.exists,
    createDTrace = require('../lib/index').CreateDTrace;

var backend, identifier, runner, factory;

var config = {};

var okTask = {
    name: 'OK Task',
    retry: 1,
    body: function (job, cb) {
        return cb(null);
    }
},
okWf, failWf, theJob, failWfWithError;

var helper = require('./helper');

var DTRACE = createDTrace('workflow');

test('throws on missing opts', function (t) {
    t.throws(function () {
        return new WorkflowRunner();
    }, new TypeError('opts (Object) required'));
    t.end();
});


test('throws on missing backend', function (t) {
    t.throws(function () {
        return new WorkflowRunner(config);
    }, new TypeError('opts.backend (Object) required'));
    t.end();
});


test('throws on missing dtrace', function (t) {
    config = helper.config();
    t.throws(function () {
        return new WorkflowRunner(config);
    }, new TypeError('opts.dtrace (Object) required'));
    t.end();
});


test('setup', function (t) {
    config.dtrace = DTRACE;
    identifier = config.runner.identifier;
    config.logger = {
        streams: [ {
            level: 'info',
            stream: process.stdout
        }, {
            level: 'trace',
            path: path.resolve(__dirname, './test.runner.log')
        }]
    };
    runner = new WorkflowRunner(config);
    t.ok(runner);
    t.ok(runner.backend, 'backend ok');
    backend = runner.backend;
    runner.init(function (err) {
        t.ifError(err, 'runner init error');
        factory = Factory(backend);
        t.ok(factory);

        // okWf:
        factory.workflow({
            name: 'OK wf',
            chain: [okTask],
            timeout: 60
        }, function (err, wf) {
            t.ifError(err, 'ok wf error');
            t.ok(wf, 'OK wf OK');

            var schedule = {
                target: 'schedule-test',
                workflow: wf.uuid,
                exec_schedule: ''
            };

            factory.schedule(schedule, function(err, schedule) {
                console.log(arguments);
            });

            schedule = {
                target: 'schedule-test-2',
                workflow: wf.uuid,
                exec_schedule: '*/2'
            };

            factory.schedule(schedule, function(err, schedule) {
                console.log(arguments);
            });
        });


        runner.run();
    });
});