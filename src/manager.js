const assert = require('assert');
const EventEmitter = require('events').EventEmitter; //node 0.10 compatibility;
const Db = require('./db');
const uuid = require('node-uuid');
const Worker = require('./worker');
const plans = require('./plans');
const Promise = require('bluebird');

class Manager extends EventEmitter {
    constructor(config){
        super();

        this.config = config;
        this.db = new Db(config);

        this.workerInterval = config.newJobCheckIntervalSeconds * 1000;
        this.monitorInterval = config.expireCheckIntervalSeconds * 1000;
        this.nextJobCommand = plans.fetchNextJob(config.schema);
        this.expireJobCommand = plans.expireJob(config.schema);
        this.insertJobCommand = plans.insertJob(config.schema);
        this.completeJobCommand = plans.completeJob(config.schema);

        this.workers = [];
    }

    monitor(){
        var self = this;

        return timeoutOldJobs();

        function timeoutOldJobs(){
            return self.db.executeSql(self.expireJobCommand)
                .catch(error => self.emit('error', error))
                .then(() => setTimeout(timeoutOldJobs, self.monitorInterval));
        }
    }

    subscribe(name, ...args){
        assert(name, 'boss requires all jobs to have a name');

        var options;
        var callback;

        if(args.length === 1){
            callback = args[0];
            options = {};
        } else if (args.length === 2){
            options = args[0] || {};
            callback = args[1];
        }
        
        assert(typeof callback == 'function', 'expected a callback function');
        if(options)
            assert(typeof options == 'object', 'expected config to be an object');
        
        options.teamSize = options.teamSize || 1;

        let jobFetcher = () =>
            this.db.executePreparedSql('nextJob', this.nextJobCommand, name)
                .then(result => result.rows.length ? result.rows[0] : null);

        let workerConfig = {name: name, fetcher: jobFetcher, interval: this.workerInterval};

        for(let w=0; w < options.teamSize; w++){

            let worker = new Worker(workerConfig);

            worker.on('error', error => this.emit('error', error));

            worker.on(name, job => {
                job.name = name;
                this.emit('job', job);
                setImmediate(() => callback(job, () => this.completeJob(job.id)));
            });

            worker.start();

            this.workers.push(worker);
        }
    }

    publish(...args){
        var name, data, options;

        if(typeof args[0] == 'string') {

            name = args[0];
            data = args[1];
            options = args[2];

        } else if(typeof args[0] == 'object'){

            assert(arguments.length === 1, 'publish object API only accepts 1 argument');

            var job = args[0];
            
            assert(job, 'boss requires all jobs to have a name');

            name = job.name;
            data = job.data;
            options = job.options;
        }

        assert(name, 'boss requires all jobs to have a name');
        options = options || {};

        let self = this;
        
        return new Promise(deferred);
        

        function deferred(resolve, reject){

            insertJob();

            function insertJob(){
                let startIn =
                    (options.startIn > 0) ? '' + options.startIn
                        : (typeof options.startIn == 'string') ? options.startIn
                        : '0';

                let singletonSeconds =
                    (options.singletonSeconds > 0) ? options.singletonSeconds
                        : (options.singletonMinutes > 0) ? options.singletonMinutes * 60
                        : (options.singletonHours > 0) ? options.singletonHours * 60 * 60
                        : (options.singletonDays > 0) ? options.singletonDays * 60 * 60 * 24
                        : null;

                let id = uuid[self.config.uuid](),
                    state = 'created',
                    retryLimit = options.retryLimit || 0,
                    expireIn = options.expireIn || '15 minutes',
                    singletonOffset = options.singletonOffset || 0;

                let values = [id, name, state, retryLimit, startIn, expireIn, data, singletonSeconds, singletonOffset];

                self.db.executeSql(self.insertJobCommand, values)
                    .then(result => {
                        if(result.rowCount === 1)
                            return resolve(id);

                        if(singletonSeconds && options.startIn != singletonSeconds){
                            options.startIn = singletonSeconds;
                            options.singletonOffset = singletonSeconds;

                            insertJob();
                        }
                        else {
                            resolve(null);
                        }
                    })
                    .catch(error => reject(error));
            }

        }

    }

    completeJob(id){
        return this.db.executeSql(this.completeJobCommand, [id]);
    }
}

module.exports = Manager;