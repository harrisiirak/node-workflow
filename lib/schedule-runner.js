var util = require('util'),
    async = require('async');

var WorkflowScheduleRunner = module.exports = function (opts) {
    if (typeof (opts) !== 'object') {
        throw new TypeError('opts (Object) required');
    }

    if (typeof (opts.runner) !== 'object') {
        throw new TypeError('opts.runner (Object) required');
    }

    if (typeof (opts.backend) !== 'object') {
        throw new TypeError('opts.backend (Object) required');
    }

    if (typeof (opts.dtrace) !== 'object') {
        throw new TypeError('opts.dtrace (Object) required');
    }

    this.runner = opts.runner;
    this.job = opts.job;
    this.backend = opts.backend;
    this.log = opts.runner.log.child(null, true);
    this.dtrace = opts.dtrace;
};

WorkflowScheduleRunner.prototype.run = function (callback) {
    var self = this;
    self.log.info('Run job scheduler');

    // Run queued schedule jobs and complete finished schedule jobs
    self.backend.runSchedules(function (err) {
        if (err) {
            self.log.error({err: err},
                'Error finishing pending schedules');
            callback(err);
            return;
        }

        // Find and queue next schedule jobs
        self.backend.nextSchedules(function (err, schedules) {
            if (err) {
                self.log.error({err: err},
                    'Error getting next schedules');
                callback(err);
                return;
            }

            // Create schedule jobs
            if (schedules.length > 0) {
                var count = 0;
                for (var i = 0, c = schedules.length; i < c; i++) {
                    count++;

                    self.backend.createScheduleJob(schedules[i],
                        function (err, scheduleJob) {
                        if (err) {
                            self.log.error({err: err},
                                'Error creating schedule job');
                            callback(err);
                        }

                        if (--count === 0) {
                            callback();
                        }
                    });
                }
            } else {
                callback();
            }
        });
    });
};