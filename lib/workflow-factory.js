// Copyright 2012 Pedro P. Candel <kusorbox@gmail.com>. All rights reserved.
var uuid = require('node-uuid'),
    util = require('util');

var WorkflowFactory = module.exports = function (backend) {
    this.backend = backend;
};

// Create a workflow and store it on the backend
//
// - workflow - the workflow object properties:
//   - name: string workflow name, uniqueness enforced.
//   - timeout: integer, acceptable time, in seconds, to run the wf.
//     (60 minutes if nothing given). Also, the Boolean `false` can be used
//     to explicitly create a workflow without a timeout.
//   - chain: An array of Tasks to run.
//   - onerror: An array of Tasks to run in case `chain` fails.
// - opts - Object, any additional information to be passed to the backend
//          when creating a workflow object which are not workflow properties,
//          like HTTP request ID or other meta information.
// - callback - function(err, workflow)
//
// Every Task can have the following members:
//   - name - string task name, optional.
//   - body - function(job, cb) the task main function. Required.
//   - fallback: function(err, job, cb) a function to run in case `body` fails
//     Optional.
//   - retry: Integer, number of attempts to run the task before try `fallback`
//     Optional. By default, just one retry.
//   - timeout: Integer, acceptable time, in seconds, a task execution should
//     take, before fail it with timeout error. Optional.
//
WorkflowFactory.prototype.workflow = function (workflow, opts, callback) {
    var self = this,
        wf = workflow || {};

    if (typeof (opts) === 'function') {
        callback = opts;
        opts = {};
    }

    function validateTask(task, cb) {
        var p;

        if (!task.body) {
            return cb('Task "body" is required');
        }

        if (typeof (task.body) !== 'function') {
            return cb('Task "body" must be a function');
        }

        if (!task.uuid) {
            task.uuid = uuid();
        }

        // Ensure that if task.fallback is given, it's a function
        if (task.fallback && typeof (task.fallback) !== 'function') {
            return cb('Task "fallback" must be a function');
        }

        for (p in task) {
            if (typeof (task[p]) === 'function') {
                task[p] = task[p].toString();
            }
        }
        return task;
    }

    if (!wf.name) {
        return callback('Workflow "name" is required');
    }

    if (wf.chain && (
          typeof (wf.chain) !== 'object' ||
          typeof (wf.chain.length) === 'undefined')) {
        return callback('Workflow "chain" must be an array');
    }

    if (!wf.chain) {
        wf.chain = [];
    }

    if (!wf.uuid) {
        wf.uuid = uuid();
    }

    if (wf.onError) {
        wf.onerror = wf.onError;
        delete wf.onError;
    }

    if (wf.onerror && (
          typeof (wf.onerror) !== 'object' ||
          typeof (wf.onerror.length) === 'undefined')) {
        return callback('Workflow "onerror" must be an array');
    }

    wf.chain.forEach(function (task, i, arr) {
        wf.chain[i] = validateTask(task, callback);
    });

    if (wf.onerror) {
        wf.onerror.forEach(function (task, i, arr) {
            wf.onerror[i] = validateTask(task, callback);
        });
    }

    if (typeof (wf.timeout) !== 'number') {
        wf.timeout = 3600;
    } else if (wf.timeout === 0) {
        delete wf.timeout;
    }

    return self.backend.createWorkflow(wf, function (err, result) {
        if (err) {
            return callback(err);
        } else {
            return callback(null, wf);
        }
    });
};

// Validate job(s) targets and parameters:
//
// - jobs - a single job object or a list of jobs
// - callback - f(err)
WorkflowFactory.prototype.validateJob = function (jobs, callback) {
    var self = this;
    var called = false;

    // If only one object is given
    if (typeof jobs === 'object' && !jobs.length) {
        jobs = [ jobs ];
    }

    var count = jobs.length;
    for (var i = 0, c = count; i < c; i++) {
        if (called) {
            continue;
        }

        var job = jobs[i];

        if (!job.workflow) {
            return callback('"j.workflow" is required');
        }

        self.backend.getWorkflow(job.workflow, function (err, wf) {
            if (err && !called) {
                --count;
                called = true;

                return callback(err);
            }

            if (Object.keys(wf).length === 0) {
                return callback('Cannot create a job from' +
                    'an unexisting workflow');
            }

            if (wf.chain.length === 0) {
                return callback(
                  'Cannot queue a job from a workflow without any task');
            }

            for (var p in wf) {
                if (p !== 'uuid') {
                    job[p] = wf[p];
                } else {
                    job.workflow_uuid = wf.uuid;
                }
            }

            job.params = job.params || {};

            self.backend.validateJobTarget(job, function (err) {
                if (err && !called) {
                    called = true;

                    self.backend.getJobByTarget(job.target, function (_err, job) {
                        --count;

                        if (_err) {
                            return callback(_err);
                        }

                        return callback(err, job);
                    });
                }

                if (!called && --count === 0) {
                    called = true;
                    return callback();
                }
            });
        });
    };
};

// Create a queue a Job from the given Workflow:
//
// - j - the Job object workflow and extra arguments:
//   - workflow - (required) UUID of Workflow object to create the job from.
//   - params - (opt) JSON object, parameters to pass to the job during exec
//   - target - (opt) String, Job's target, used to ensure that we don't
//              queue two jobs with the same target and params at once.
//   - exec_after - (opt) ISO 8601 Date, delay job execution after the
//                  given timestamp (execute from now when not given).
// - opts - Object, any additional information to be passed to the backend
//          when creating a workflow object which are not workflow properties,
//          like HTTP request ID or other meta information.
// - callback - f(err, job)
WorkflowFactory.prototype.job = function (j, opts, callback) {
    var self = this,
        job = { execution: 'queued', chain_results: []};

    if (!j.workflow) {
        return callback('"j.workflow" is required');
    }

    if (typeof (opts) === 'function') {
        callback = opts;
        opts = {};
    }

    return self.backend.getWorkflow(j.workflow, function (err, wf) {
        var p;
        if (err) {
            return callback(err);
        }

        if (Object.keys(wf).length === 0) {
            return callback('Cannot create a job from an unexisting workflow');
        }

        if (wf.chain.length === 0) {
            return callback(
              'Cannot queue a job from a workflow without any task');
        }

        for (p in wf) {
            if (p !== 'uuid') {
                job[p] = wf[p];
            } else {
                job.workflow_uuid = wf.uuid;
            }
        }

        job.exec_after = j.exec_after || new Date().toISOString();
        job.params = j.params || {};

        if (j.uuid) {
            job.uuid = j.uuid;
        }

        if (!job.uuid) {
            job.uuid = uuid();
        }

        if (j.target) {
            job.target = j.target;
        }

        return self.backend.validateJobTarget(job, function (err) {
            if (err) {
                return callback(err);
            } else {
                return self.backend.createJob(job, function (err, results) {
                    if (err) {
                        return callback(err);
                    } else {
                        return callback(null, job);
                    }
                });
            }
        });
    });
};

// Create a Schedule from the given Workflow:
//
// - schedule - the Schedule object workflow and extra arguments:
//   - workflow - (required) UUID of Workflow object to create the schedule from.
//   - params - (opt) JSON object, parameters to pass to the job during exec
//   - target - (opt) String, Schedule's target, used to ensure that we don't
//              queue two schedules with the same target and params at once.
//   - exec_schedule - (opt) Schedule execution interval/schedule, in cron format.
// - callback - f(err, schedule)
WorkflowFactory.prototype.schedule = function (schedule, opts, callback) {
    var self = this;

    if (!schedule.workflow) {
        return callback('"schedule.workflow" is required');
    }

    if (typeof (opts) === 'function') {
        callback = opts;
        opts = {};
    }

    return self.backend.getWorkflow(schedule.workflow, function (err, wf) {
        if (err) {
            return callback(err);
        }

        schedule.workflow_uuid = wf.uuid;
        schedule.exec_schedule = schedule.exec_schedule || '';
        schedule.params = schedule.params || {};

        if (!schedule.uuid) {
            schedule.uuid = uuid();
        }

        return self.backend.validateSchedule(schedule, function (err) {
            if (err) {
                return callback(err);
            } else {
                return self.backend.createSchedule(schedule,
                    function (err, results) {

                    if (err) {
                        return callback(err);
                    } else {
                        return callback(null, schedule);
                    }
                });
            }
        });
    });
};