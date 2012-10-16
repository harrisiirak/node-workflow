// Copyright 2012 Pedro P. Candel <kusorbox@gmail.com>. All rights reserved.

var util = require('util'),
    uuid = require('node-uuid'),
    async = require('async'),
    Logger = require('bunyan'),
    e = require('./errors'),
    WorkflowFactory = require('./workflow-factory'),
    WorkflowBackend = require('./workflow-backend'),
    CronParser = require('cron-parser');

var sprintf = util.format;

var Backend = module.exports = function (config) {
    WorkflowBackend.call(this);
    if (config.log) {
        this.log = config.log.child({component: 'wf-in-memory-backend'});
    } else {
        if (!config.logger) {
            config.logger = {};
        }

        config.logger.name = 'wf-in-memory-backend';
        config.logger.serializers = {
            err: Logger.stdSerializers.err
        };

        config.logger.streams = config.logger.streams || [ {
            level: 'info',
            stream: process.stdout
        }];

        this.log = new Logger(config.logger);
    }
    this.config = config;
    this.workflows = null;
    this.jobs = null;
    this.schedules = null;
    this.schedule_jobs = null;
    this.runners = null;
    this.queued_jobs = null;
};

util.inherits(Backend, WorkflowBackend);

// You'd think the language would provide this...
// This method assumes an acyclic graph.
var deepCopy = function (obj) {
    switch (typeof (obj)) {
    case 'object':
        if (obj === null) {
            return null;
        } else {
            var clone, i;
            if (typeof (obj.length) === 'number') {
                clone = [];
                for (i = obj.length - 1; i >= 0; i -= 1) {
                    clone[i] = deepCopy(obj[i]);
                }
                return clone;
            } else {
                clone = {};
                for (i in obj) {
                    clone[i] = deepCopy(obj[i]);
                }
            }
            return clone;
        }
    case 'string':
        return '' + obj;
    default:
        return obj;
    }
};

Backend.prototype.init = function (callback) {
    var self = this;
    self.workflows = {};
    self.jobs = {};
    self.schedules = {};
    self.schedule_jobs = [];
    self.runners = {};
    self.queued_jobs = [];
    callback();
};

// Callback - f(err);
Backend.prototype.quit = function (callback) {
    callback();
};


// workflow - Workflow object
// meta - Any additional information to pass to the backend which is not
//        workflow properties
// callback - f(err, workflow)
Backend.prototype.createWorkflow = function (workflow, meta, callback) {
    if (typeof (meta) === 'function') {
        callback = meta;
        meta = {};
    }
    var self = this;
    if (self._wfNames().indexOf(workflow.name) !== -1) {
        return callback(new e.BackendInvalidArgumentError(
          'Workflow.name must be unique. A workflow with name "' +
          workflow.name + '" already exists'));
    } else {
        self.workflows[workflow.uuid] = deepCopy(workflow);
        return callback(null, workflow);
    }
};


// uuid - Workflow.uuid
// meta - Any additional information to pass to the backend which is not
//        workflow properties
// callback - f(err, workflow)
Backend.prototype.getWorkflow = function (uuid, meta, callback) {
    if (typeof (meta) === 'function') {
        callback = meta;
        meta = {};
    }

    var self = this;
    if (self.workflows[uuid]) {
        return callback(null, deepCopy(self.workflows[uuid]));
    } else {
        return callback(new e.BackendResourceNotFoundError(sprintf(
          'Workflow with uuid \'%s\' does not exist', uuid)));
    }
};


// workflow - the workflow object
// meta - Any additional information to pass to the backend which is not
//        workflow properties
// callback - f(err, boolean)
Backend.prototype.deleteWorkflow = function (workflow, meta, callback) {
    if (typeof (meta) === 'function') {
        callback = meta;
        meta = {};
    }

    var self = this;
    if (self.workflows[workflow.uuid]) {
        return callback(null, (delete self.workflows[workflow.uuid]));
    } else {
        return callback(null, false);
    }
};

// workflow - update workflow object.
// meta - Any additional information to pass to the backend which is not
//        workflow properties
// callback - f(err, workflow)
Backend.prototype.updateWorkflow = function (workflow, meta, callback) {
    if (typeof (meta) === 'function') {
        callback = meta;
        meta = {};
    }

    var self = this;

    if (self.workflows[workflow.uuid]) {
        if (self._wfNames().indexOf(workflow.name) !== -1 &&
            self.workflows[workflow.uuid].name !== workflow.name) {
            return callback(new e.BackendInvalidArgumentError(
              'Workflow.name must be unique. A workflow with name "' +
              workflow.name + '" already exists'));
        } else {
            self.workflows[workflow.uuid] = deepCopy(workflow);
            return callback(null, workflow);
        }
    } else {
        return callback(new e.BackendResourceNotFoundError(
          'Workflow does not exist. Cannot Update.'));
    }
};


// job - Job object
// meta - Any additional information to pass to the backend which is not
//        job properties
// callback - f(err, job)
Backend.prototype.createJob = function (job, meta, callback) {
    if (typeof (meta) === 'function') {
        callback = meta;
        meta = {};
    }

    var self = this;

    job.created_at = job.created_at || new Date().toISOString();
    self.jobs[job.uuid] = deepCopy(job);
    self.queued_jobs.push(job.uuid);
    return callback(null, job);
};


// uuid - Job.uuid
// meta - Any additional information to pass to the backend which is not
//        job properties
// callback - f(err, job)
Backend.prototype.getJob = function (uuid, meta, callback) {
    if (typeof (meta) === 'function') {
        callback = meta;
        meta = {};
    }
    var self = this;

    if (self.jobs[uuid]) {
        return callback(null, deepCopy(self.jobs[uuid]));
    } else {
        return callback(new e.BackendResourceNotFoundError(sprintf(
          'Job with uuid \'%s\' does not exist', uuid)));
    }
};


// Get a single job property
// uuid - Job uuid.
// prop - (String) property name
// cb - callback f(err, value)
Backend.prototype.getJobProperty = function (uuid, prop, cb) {
    var self = this;

    if (self.jobs[uuid]) {
        return cb(null, self.jobs[uuid][prop]);
    } else {
        return cb(new e.BackendResourceNotFoundError(sprintf(
          'Job with uuid \'%s\' does not exist', uuid)));
    }
};

// job - the job object
// callback - f(err) called with error in case there is a duplicated
// job with the same target and same params
Backend.prototype.validateJobTarget = function (job, callback) {
    var self = this, filtered;
    // If no target is given, we don't care:
    if (!job.target) {
        return callback(null);
    }

    if (self._jobTargets().indexOf(job.target) === -1) {
        return callback(null);
    }

    filtered = Object.keys(self.jobs).filter(function (uuid) {
        return (
          uuid !== job.uuid &&
          self.jobs[uuid].target === job.target &&
          Object.keys(job.params).every(function (p) {
            return (self.jobs[uuid].params[p] &&
              self.jobs[uuid].params[p] === job.params[p]);
        }) &&
          (self.jobs[uuid].execution === 'queued' ||
           self.jobs[uuid].execution === 'running'));
    });

    if (filtered.length !== 0) {
        return callback(new e.BackendInvalidArgumentError(
          'Another job with the same target' +
          ' and params is already queued'));
    } else {
        return callback(null);
    }
};

// Get the next queued job.
// index - Integer, optional. When given, it'll get the job at index position
//         (when not given, it'll return the job at position zero).
// callback - f(err, job)
Backend.prototype.nextJob = function (index, callback) {
    var self = this,
        slice = null;

    if (typeof (index) === 'function') {
        callback = index;
        index = 0;
    }

    if (self.queued_jobs.length === 0) {
        return callback(null, null);
    }

    slice = self.queued_jobs.slice(index, index + 1);

    if (slice.length === 0) {
        return callback(null, null);
    } else {
        return self.getJob(slice[0], callback);
    }
};

// Lock a job, mark it as running by the given runner, update job status.
// uuid - the job uuid (String)
// runner_id - the runner identifier (String)
// callback - f(err, job) callback will be called with error if something
//            fails, otherwise it'll return the updated job using getJob.
Backend.prototype.runJob = function (uuid, runner_id, callback) {
    var self = this,
        idx = self.queued_jobs.indexOf(uuid);
    if (idx === -1) {
        return callback(new e.BackendPreconditionFailedError(
          'Only queued jobs can be run'));
    } else {
        self.queued_jobs.splice(idx, 1);
        self.jobs[uuid].runner_id = runner_id;
        self.jobs[uuid].execution = 'running';
        return callback(null, deepCopy(self.jobs[uuid]));
    }
};

// Unlock the job, mark it as finished, update the status, add the results
// for every job's task.
// job - the job object. It'll be saved to the backend with the provided
//       properties.
// callback - f(err, job) callback will be called with error if something
//            fails, otherwise it'll return the updated job using getJob.
Backend.prototype.finishJob = function (job, callback) {
    var self = this;
    if (!self.jobs[job.uuid]) {
        return callback(new e.BackendResourceNotFoundError(sprintf(
          'Job with uuid \'%s\' does not exist', job.uuid)));
    } else if (self.jobs[job.uuid].execution !== 'running' &&
        self.jobs[job.uuid].execution !== 'canceled') {
        return callback(new e.BackendPreconditionFailedError(
          'Only running jobs can be finished'));
    } else {
        if (job.execution === 'running') {
            job.execution = 'succeeded';
        }
        var info = self.jobs[job.uuid].info;
        job.runner_id = null;
        self.jobs[job.uuid] = deepCopy(job);
        if (info) {
            self.jobs[job.uuid].info = info;
        }
        return callback(null, job);
    }
};


// Update the job while it is running with information regarding progress
// job - the job object. It'll be saved to the backend with the provided
//       properties.
// meta - Any additional information to pass to the backend which is not
//        job properties
// callback - f(err, job) callback will be called with error if something
//            fails, otherwise it'll return the updated job using getJob.
Backend.prototype.updateJob = function (job, meta, callback) {
    if (typeof (meta) === 'function') {
        callback = meta;
        meta = {};
    }

    var self = this;

    if (!self.jobs[job.uuid]) {
        return callback(new e.BackendResourceNotFoundError(sprintf(
          'Job with uuid \'%s\' does not exist', job.uuid)));
    } else {
        self.jobs[job.uuid] = deepCopy(job);
        return callback(null, job);
    }
};

// Update only the given Job property. Intendeed to prevent conflicts with
// two sources updating the same job at the same time, but different properties
// uuid - the job's uuid
// prop - the name of the property to update
// val - value to assign to such property
// meta - Any additional information to pass to the backend which is not
//        job properties
// callback - f(err) called with error if something fails, otherwise with null.
Backend.prototype.updateJobProperty = function (
    uuid,
    prop,
    val,
    meta,
    callback)
{

    if (typeof (meta) === 'function') {
        callback = meta;
        meta = {};
    }

    var self = this;

    if (!self.jobs[uuid]) {
        return callback(new e.BackendResourceNotFoundError(sprintf(
          'Job with uuid \'%s\' does not exist', uuid)));
    } else {
        self.jobs[uuid][prop] = val;
        return callback(null);
    }
};


// Queue a job which has been running; i.e, due to whatever the reason,
// re-queue the job. It'll unlock the job, update the status, add the
// results for every finished task so far ...
// job - the job Object. It'll be saved to the backend with the provided
//       properties to ensure job status persistence.
// callback - f(err, job) callback will be called with error if something
//            fails, otherwise it'll return the updated job using getJob.
Backend.prototype.queueJob = function (job, callback) {
    var self = this;

    if (!self.jobs[job.uuid]) {
        return callback(new e.BackendResourceNotFoundError(sprintf(
          'Job with uuid \'%s\' does not exist', job.uuid)));
    } else if (self.jobs[job.uuid].execution !== 'running') {
        return callback(new e.BackendPreconditionFailedError(
          'Only running jobs can be queued again'));
    } else {
        job.runner_id = null;
        job.execution = 'queued';
        self.jobs[job.uuid] = deepCopy(job);
        self.queued_jobs.push(job.uuid);
        return callback(null, job);
    }
};


// Get the given number of queued jobs uuids.
// - start - Integer - Position of the first job to retrieve
// - stop - Integer - Position of the last job to retrieve, _included_
// - callback - f(err, jobs)
Backend.prototype.nextJobs = function (start, stop, callback) {
    var self = this,
        slice = [];

    if (self.queued_jobs.length === 0) {
        return callback(null, null);
    }

    slice = self.queued_jobs.slice(start, stop + 1);

    if (slice.length === 0) {
        return callback(null, null);
    } else {
        return callback(null, slice);
    }
};


// schedule - Schedule object
// meta - Any additional information to pass to the backend which is not
//        schedule properties
// callback - f(err, job)
Backend.prototype.createSchedule = function (schedule, meta, callback) {
    if (typeof (meta) === 'function') {
        callback = meta;
        meta = {};
    }

    var self = this;

    self.schedules[schedule.uuid] = deepCopy(schedule);
    return callback(null, schedule);
};


// uuid - Schedule.uuid
// meta - Any additional information to pass to the backend which is not
//        schedule properties
// callback - f(err, job)
Backend.prototype.getSchedule = function (uuid, meta, callback) {
    if (typeof (meta) === 'function') {
        callback = meta;
        meta = {};
    }
    var self = this;

    if (self.schedules[uuid]) {
        return callback(null, deepCopy(self.schedules[uuid]));
    } else {
        return callback(new e.BackendResourceNotFoundError(sprintf(
          'Schedule with uuid \'%s\' does not exist', uuid)));
    }
};


// Get all the schedules:
// - callback - f(err, schedules)
Backend.prototype.getSchedules = function (callback) {
    var self = this;

    return callback(null, Object.keys(self.schedules).map(function (uuid) {
        return deepCopy(self.schedules[uuid]);
    }));
};


// schedule - the schedule object. It'll be saved to the backend with the
//       provided properties.
// meta - Any additional information to pass to the backend which is not
//        schedule properties
// callback - f(err, job) callback will be called with error if something
//            fails, otherwise it'll return the updated job using getJob.
Backend.prototype.updateSchedule = function (schedule, meta, callback) {
    if (typeof (meta) === 'function') {
        callback = meta;
        meta = {};
    }

    var self = this;

    if (!self.schedules[schedule.uuid]) {
        return callback(new e.BackendResourceNotFoundError(sprintf(
          'Schedule with uuid \'%s\' does not exist', schedule.uuid)));
    } else {
        self.schedules[schedule.uuid] = deepCopy(schedule);
        return callback(null, schedule);
    }
};


// schedule - the schedule object
// meta - Any additional information to pass to the backend which is not
//        schedule properties
// callback - f(err, boolean)
Backend.prototype.deleteSchedule = function (schedule, meta, callback) {
    if (typeof (meta) === 'function') {
        callback = meta;
        meta = {};
    }

    var self = this;
    if (self.schedules[schedule.uuid]) {
        return callback(null, (delete self.schedules[schedule.uuid]));
    } else {
        return callback(null, false);
    }
};


Backend.prototype.runSchedules = function (callback) {
    var self = this,
        now = Date.now(),
        count = 0,
        called = false;

    for (var i = 0, c = this.schedule_jobs.length; i < c; i++) {
        (function (i) {
            var scheduleJob = self.schedule_jobs[i];

            // Queued schedule job
            if (scheduleJob.execution === 'queued' &&
                now >= Date.parse(scheduleJob.exec_after)) {

                scheduleJob.execution = 'running';
                count++;

                self.getSchedule(scheduleJob.schedule_uuid,
                    function (err, schedule) {
                    if (err) {
                        scheduleJob.execution = 'failed';
                        self.log.error({err: err}, 'Failed to get schedule');
                    } else {
                        var job = { execution: 'queued', chain_results: [] };
                        for (var key in schedule) {
                            if (key !== 'exec_schedule' &&
                                key !== 'uuid') {
                                job[key] = schedule[key];
                            }
                        }

                        var factory = new WorkflowFactory(self);
                        factory.job(job, null, function (err, job) {
                            self.schedule_jobs[i].job_uuid = job.uuid;

                            if (--count === 0) {
                                called = true;
                                callback();
                            }
                        });
                    }
                });

            // Finalize
            } else if (scheduleJob.execution === 'running' &&
                       scheduleJob.job_uuid) {

                count++;
                self.getJob(scheduleJob.job_uuid, function (err, job) {
                    if (job && (job.execution === 'succeeded' ||
                        job.execution === 'failed' ||
                        job.execution === 'canceled')) {

                        self.schedule_jobs[i].execution = job.execution;
                    }

                    if (--count === 0) {
                        called = true;
                        callback();
                    }
                });
            }
        })(i);
    }

    if (!called) callback();
};


Backend.prototype.nextSchedules = function (callback) {
    var schedules = [];
    for (var uuid in this.schedules) {
        var append = true;

        for (var i = 0, c = this.schedule_jobs.length; i < c; i++) {
            if (this.schedule_jobs[i].schedule_uuid === uuid &&
                (this.schedule_jobs[i].execution === 'queued' ||
                 this.schedule_jobs[i].execution === 'running')) {
                append = false;
                break;
            }
        }

        if (append) {
            schedules.push(this.schedules[uuid]);
        }
    }

    callback(null, schedules);
};


Backend.prototype.createScheduleJob = function (schedule, callback) {
    var self = this;
    var exists = false;

    for (var i = 0, c = this.schedule_jobs.length; i < c; i++) {
        if (this.schedule_jobs[i].schedule_uuid === schedule.uuid &&
            (this.schedule_jobs[i].execution === 'queued' ||
             this.schedule_jobs[i].execution === 'running')) {
            exists = true;
            break;
        }
    }

    if (exists) {
        callback(new e.BackendResourceNotFoundError(sprintf(
          'Schedule job with uuid \'%s\' already exist', schedule.uuid)));
    } else {
        CronParser.parseDateExpression(
            schedule.exec_schedule,
            { date: new Date() },
            function (err, interval) {

            if (err) {
                callback(
                    new e.BackendInternal('Error while parsing ' +
                        'execution schedule expression'));
            } else {
                var scheduleJob = {
                    uuid: uuid(),
                    schedule_uuid: schedule.uuid,
                    job_uuid: null,
                    exec_after: interval.next(),
                    execution: 'queued'
                };

                self.schedule_jobs.push(scheduleJob);
                callback(null, scheduleJob);
            }
        });
    }
};

// schedule - the schedule object
// callback - f(err) called with error in case there is a duplicated
// schedule with the same target and same params
Backend.prototype.validateSchedule = function (schedule, callback) {
    var self = this, filtered;

    // If no target is given, we don't care:
    if (!schedule.target) {
        return callback(null);
    }

    if (self._scheduleTargets().indexOf(schedule.target) === -1) {
        return callback(null);
    }

    filtered = Object.keys(self.schedules).filter(function (uuid) {
        return (
          uuid !== schedule.uuid &&
          self.schedules[uuid].target === schedule.target &&
          Object.keys(schedule.params).every(function (p) {
            return (self.schedules[uuid].params[p] &&
              self.schedules[uuid].params[p] === schedule.params[p]);
        }));
    });

    if (filtered.length !== 0) {
        return callback(new e.BackendInvalidArgumentError(
          'Another schedule with the same target' +
          ' and params is already exist'));
    } else {
        return callback(null);
    }
};


// Register a runner on the backend and report it's active:
// - runner_id - String, unique identifier for runner.
// - active_at - ISO String timestamp. Optional. If none is given, current time
// - callback - f(err)
Backend.prototype.registerRunner = function (
    runner_id,
    active_at,
    callback
) {
    var self = this;
    if (typeof (active_at) === 'function') {
        callback = active_at;
        active_at = new Date();
    }
    if (typeof (active_at) === 'string') {
        active_at = new Date(active_at);
    }
    self.runners[runner_id] = {
        runner_id: runner_id,
        active_at: active_at,
        idle: false
    };
    return callback(null);
};

// Report a runner remains active:
// - runner_id - String, unique identifier for runner. Required.
// - active_at - ISO String timestamp. Optional. If none is given, current time
// - callback - f(err)
Backend.prototype.runnerActive = function (
    runner_id,
    active_at,
    callback
) {
    var self = this;
    return self.registerRunner(runner_id, active_at, callback);
};

// Get the given runner id details
// - runner_id - String, unique identifier for runner. Required.
// - callback - f(err, runner)
Backend.prototype.getRunner = function (runner_id, callback) {
    var self = this;
    if (!self.runners[runner_id]) {
        return callback(new e.BackendResourceNotFoundError(sprintf(
          'Runner with uuid \'%s\' does not exist', runner_id)));
    } else {
        return callback(null, self.runners[runner_id].active_at);
    }
};


// Get all the registered runners:
// - callback - f(err, runners)
Backend.prototype.getRunners = function (callback) {
    var self = this,
        theRunners = {};

    Object.keys(self.runners).forEach(function (uuid) {
        theRunners[uuid] = self.runners[uuid].active_at;
    });

    return callback(null, theRunners);
};

// Set a runner as idle:
// - runner_id - String, unique identifier for runner
// - callback - f(err)
Backend.prototype.idleRunner = function (runner_id, callback) {
    var self = this;
    if (!self.runners[runner_id]) {
        return callback(new e.BackendResourceNotFoundError(sprintf(
          'Runner with uuid \'%s\' does not exist', runner_id)));
    } else {
        self.runners[runner_id].idle = true;
        return callback(null);
    }
};

// Check if the given runner is idle
// - runner_id - String, unique identifier for runner
// - callback - f(boolean)
Backend.prototype.isRunnerIdle = function (runner_id, callback) {
    var self = this;
    if (!self.runners[runner_id] || (self.runners[runner_id].idle === true)) {
        return callback(true);
    } else {
        return callback(false);
    }
};

// Remove idleness of the given runner
// - runner_id - String, unique identifier for runner
// - callback - f(err)
Backend.prototype.wakeUpRunner = function (runner_id, callback) {
    var self = this;
    if (!self.runners[runner_id]) {
        return callback(new e.BackendResourceNotFoundError(sprintf(
          'Runner with uuid \'%s\' does not exist', runner_id)));
    } else {
        self.runners[runner_id].idle = false;
        return callback(null);
    }
};

// Get all jobs associated with the given runner_id
// - runner_id - String, unique identifier for runner
// - callback - f(err, jobs). `jobs` is an array of job's UUIDs.
//   Note `jobs` will be an array, even when empty.
Backend.prototype.getRunnerJobs = function (runner_id, callback) {
    var self = this,
        wf_runner_jobs = Object.keys(self.jobs).filter(function (uuid) {
            return self.jobs[uuid].runner_id === runner_id;
        });

    return callback(null, wf_runner_jobs);
};


// Get all the workflows:
// - callback - f(err, workflows)
Backend.prototype.getWorkflows = function (callback) {
    var self = this;

    return callback(null, Object.keys(self.workflows).map(function (uuid) {
        return deepCopy(self.workflows[uuid]);
    }));
};


// Get all the jobs:
// - params - JSON Object. Can include the value of the job's "execution"
//   status, and any other key/value pair to search for into job's params.
//   - execution - String, the execution status for the jobs to return.
//                 Return all jobs if no execution status is given.
// - callback - f(err, jobs)
Backend.prototype.getJobs = function (params, callback) {
    var self = this,
        executions = ['queued', 'failed', 'succeeded', 'canceled', 'running'],
        execution,
        jobs,
        theJobs = [];

    if (typeof (params) === 'object') {
        execution = params.execution;
        delete params.execution;
    }

    if (typeof (params) === 'function') {
        callback = params;
    }

    if (typeof (execution) === 'undefined') {

        jobs = Object.keys(self.jobs).map(function (uuid) {
            return deepCopy(self.jobs[uuid]);
        });

        if (typeof (params) === 'object' && Object.keys(params).length > 0) {
            jobs.forEach(function (job) {
                var matches = true;
                Object.keys(params).forEach(function (k) {
                    if (!job.params[k] || job.params[k] !== params[k]) {
                        matches = false;
                    }
                });
                if (matches === true) {
                    theJobs.push(job);
                }
            });
            return callback(null, theJobs);
        } else {
            return callback(null, jobs);
        }

    } else if (executions.indexOf(execution) !== -1) {

        jobs = Object.keys(self.jobs).filter(function (uuid) {
            return self.jobs[uuid].execution === execution;
        }).map(function (uuid) {
            return deepCopy(self.jobs[uuid]);
        });

        if (typeof (params) === 'object' && Object.keys(params).length > 0) {
            jobs.forEach(function (job) {
                var matches = true;
                Object.keys(params).forEach(function (k) {
                    if (!job.params[k] || job.params[k] !== params[k]) {
                        matches = false;
                    }
                });
                if (matches === true) {
                    theJobs.push(job);
                }
            });
            return callback(null, theJobs);
        } else {
            return callback(null, jobs);
        }

    } else {
        return callback(new e.BackendInvalidArgumentError(
          'excution is required and must be one of "' +
          executions.join('", "') + '"'));
    }
};


// Add progress information to an existing job:
// - uuid - String, the Job's UUID.
// - info - Object, {'key' => 'Value'}
// - meta - Any additional information to pass to the backend which is not
//        job info
// - callback - f(err)
Backend.prototype.addInfo = function (uuid, info, meta, callback) {

    if (typeof (meta) === 'function') {
        callback = meta;
        meta = {};
    }

    var self = this;

    if (!self.jobs[uuid]) {
        return callback(new e.BackendResourceNotFoundError(
          'Job does not exist. Cannot Update.'));
    } else {
        if (!util.isArray(self.jobs[uuid].info)) {
            self.jobs[uuid].info = [];
        }
        self.jobs[uuid].info.push(info);
        return callback(null);
    }
};


// Get progress information from an existing job:
// - uuid - String, the Job's UUID.
// - callback - f(err, info)
Backend.prototype.getInfo = function (uuid, meta, callback) {
    if (typeof (meta) === 'function') {
        callback = meta;
        meta = {};
    }
    var self = this;

    if (!self.jobs[uuid]) {
        return callback(new e.BackendResourceNotFoundError(
          'Job does not exist. Cannot get info.'));
    } else {
        if (!util.isArray(self.jobs[uuid].info)) {
            self.jobs[uuid].info = [];
        }
        return callback(null, deepCopy(self.jobs[uuid].info));
    }
};


Backend.prototype._wfNames = function () {
    var self = this,
    wf_names = Object.keys(self.workflows).map(function (uuid) {
        return self.workflows[uuid].name;
    });
    return wf_names;
};

Backend.prototype._jobTargets = function () {
    var self = this,
    wf_job_targets = Object.keys(self.jobs).map(function (uuid) {
        return self.jobs[uuid].target;
    });
    return wf_job_targets;
};

Backend.prototype._scheduleTargets = function () {
    var self = this,
    wf_schedule_targets = Object.keys(self.schedules).map(function (uuid) {
        return self.schedules[uuid].target;
    });
    return wf_schedule_targets;
};
