const assert = require('assert');
const EventEmitter = require('events');
const Promise = require('bluebird');

const Worker = require('./worker');
const plans = require('./plans');
const Attorney = require('./attorney');

const completedJobSuffix = plans.completedJobSuffix;

const events = {
  error: 'error'
};

class Manager extends EventEmitter {
  constructor(db, config){
    super();

    this.config = config;
    this.db = db;

    this.events = events;
    this.subscriptions = {};

    this.nextJobCommand = plans.fetchNextJob(config.schema);
    this.insertJobCommand = plans.insertJob(config.schema);
    this.completeJobsCommand = plans.completeJobs(config.schema);
    this.cancelJobsCommand = plans.cancelJobs(config.schema);
    this.failJobsCommand = plans.failJobs(config.schema);
    this.deleteQueueCommand = plans.deleteQueue(config.schema);
    this.deleteAllQueuesCommand = plans.deleteAllQueues(config.schema);

    // exported api to index
    this.functions = [
      this.fetch,
      this.complete,
      this.cancel,
      this.fail,
      this.publish,
      this.subscribe,
      this.unsubscribe,
      this.onComplete,
      this.offComplete,
      this.fetchCompleted,
      this.publishDebounced,
      this.publishThrottled,
      this.publishOnce,
      this.publishAfter,
      this.deleteQueue,
      this.deleteAllQueues
    ];
  }

  stop() {
    Object.keys(this.subscriptions).forEach(name => this.unsubscribe(name));
    this.subscriptions = {};
    return Promise.resolve(true);
  }

  subscribe(name, ...args){
    return Attorney.checkSubscribeArgs(name, args)
      .then(({options, callback}) => this.watch(name, options, callback));
  }

  onComplete(name, ...args) {
    return Attorney.checkSubscribeArgs(name, args)
      .then(({options, callback}) => this.watch(name + completedJobSuffix, options, callback));
  }

  watch(name, options, callback){
    assert(!(name in this.subscriptions), 'this job has already been subscribed on this instance.');

    if('newJobCheckInterval' in options || 'newJobCheckIntervalSeconds' in options)
      options = Attorney.applyNewJobCheckInterval(options);
    else
      options.newJobCheckInterval = this.config.newJobCheckInterval;

    let sendItBruh = (jobs) => {
        if (!jobs)
          return Promise.resolve();

        // if you get a batch, for now you should use complete() so you can control
        // if you need individual completion responses or if a batch complete makes more sense
        if(options.batchSize)
          return Promise.all([callback(jobs)])
            .catch(err => this.fail(jobs.map(job => job.id), err));

        // either no option was set, or teamSize was used, so call each callback one at a time
        return Promise.mapSeries(jobs, job => {
          return callback(job)
            .then(value => this.complete(jobs.id, value))
            .catch(err => this.fail(job.id, err))
        });
    };

    let workerConfig = {
      name,
      fetch: () => this.fetch(name, options.batchSize || options.teamSize || 1),
      onFetch: jobs => sendItBruh(jobs).catch(err => null), // just send it, bruh
      onError: error => this.emit(events.error, error),
      interval: options.newJobCheckInterval
    };

    let worker = new Worker(workerConfig);
    worker.start();

    let subscription = this.subscriptions[name] = {worker:null};
    subscription.worker = worker;

    return Promise.resolve(true);
  }

  unsubscribe(name){
    if(!this.subscriptions[name]) return Promise.reject(`No subscriptions for ${name} were found.`);

    this.subscriptions[name].worker.stop();
    delete this.subscriptions[name];

    return Promise.resolve(true);
  }

  offComplete(name){
    return this.unsubscribe(name + completedJobSuffix);
  }

  publish(...args){
    return Attorney.checkPublishArgs(args)
      .then(({name, data, options}) => this.createJob(name, data, options));
  }

  publishOnce(name, data, options, key) {
    return Attorney.checkPublishArgs([name, data, options])
      .then(({name, data, options}) => {

        options.singletonKey = key;

        return this.createJob(name, data, options);
      });
  }

  publishAfter(name, data, options, after) {
    return Attorney.checkPublishArgs([name, data, options])
      .then(({name, data, options}) => {

        options.startAfter = after;

        return this.createJob(name, data, options);
      });
  }

  publishThrottled(name, data, options, seconds, key) {
    return Attorney.checkPublishArgs([name, data, options])
      .then(({name, data, options}) => {

        options.singletonSeconds = seconds;
        options.singletonNextSlot = false;
        options.singletonKey = key;

        return this.createJob(name, data, options);
      });
  }

  publishDebounced(name, data, options, seconds, key) {
    return Attorney.checkPublishArgs([name, data, options])
      .then(({name, data, options}) => {

        options.singletonSeconds = seconds;
        options.singletonNextSlot = true;
        options.singletonKey = key;

        return this.createJob(name, data, options);
      });
  }

  createJob(name, data, options, singletonOffset){

    let startAfter = options.startAfter;

    startAfter = (startAfter instanceof Date && typeof startAfter.toISOString === 'function') ? startAfter.toISOString()
      : (startAfter > 0) ? '' + startAfter
      : (typeof startAfter === 'string') ? startAfter
      : null;

    let singletonSeconds =
      (options.singletonSeconds > 0) ? options.singletonSeconds
        : (options.singletonMinutes > 0) ? options.singletonMinutes * 60
        : (options.singletonHours > 0) ? options.singletonHours * 60 * 60
        : null;

    let id = require(`uuid/${this.config.uuid}`)();
    let retryLimit = options.retryLimit || 0;
    let expireIn = options.expireIn || '15 minutes';
    let priority = options.priority || 0;

    let singletonKey = options.singletonKey || null;

    singletonOffset = singletonOffset || 0;

    let values = [id, name, priority, retryLimit, startAfter, expireIn, data, singletonKey, singletonSeconds, singletonOffset];

    return this.db.executeSql(this.insertJobCommand, values)
      .then(result => {
        if(result.rowCount === 1)
          return id;

        if(!options.singletonNextSlot)
          return null;

        // delay starting by the offset to honor throttling config
        options.startAfter = singletonSeconds;
        // toggle off next slot config for round 2
        options.singletonNextSlot = false;

        let singletonOffset = singletonSeconds;

        return this.createJob(name, data, options, singletonOffset);
      });
  }

  fetch(name, batchSize) {
    const names = Array.isArray(name) ? name : [name];

    return Attorney.checkFetchArgs(names, batchSize)
      .then(() => this.db.executeSql(this.nextJobCommand, [names, batchSize || 1]))
      .then(result => {

        const jobs = result.rows.map(job => {
          job.done = (error, response) => error ? this.fail(job.id, error) : this.complete(job.id, response);
          return job;
        });

        return jobs.length === 0 ? null :
               jobs.length === 1 && !batchSize ? jobs[0] :
               jobs;
      });
  }

  fetchCompleted(name, batchSize){
    return this.fetch(name + completedJobSuffix, batchSize);
  }

  mapCompletionIdArg(id, funcName) {
    const errorMessage = `${funcName}() requires an id`;

    return Attorney.assertAsync(id, errorMessage)
      .then(() => {
        let ids = Array.isArray(id) ? id : [id];
        assert(ids.length, errorMessage);
        return ids;
      });
  }

  mapCompletionDataArg(data) {
    if(data === null || typeof data === 'undefined' || typeof data === 'function')
      return null;

    return (typeof data === 'object' && !Array.isArray(data))
      ? data
      : { value:data };
  }

  mapCompletionResponse(ids, result) {
    return {
      jobs: ids,
      requested: ids.length,
      updated: result.rowCount
    };
  }

  complete(id, data){
    return this.mapCompletionIdArg(id, 'complete')
      .then(ids => this.db.executeSql(this.completeJobsCommand, [ids, this.mapCompletionDataArg(data)])
                    .then(result => this.mapCompletionResponse(ids, result))
      );
  }

  fail(id, data){
    return this.mapCompletionIdArg(id, 'fail')
      .then(ids => this.db.executeSql(this.failJobsCommand, [ids, this.mapCompletionDataArg(data)])
        .then(result => this.mapCompletionResponse(ids, result))
      );
  }

  cancel(id) {
    return this.mapCompletionIdArg(id, 'cancel')
      .then(ids => this.db.executeSql(this.cancelJobsCommand, [ids])
        .then(result => this.mapCompletionResponse(ids, result))
      );
  }

  deleteQueue(queue){
    return this.db.executeSql(this.deleteQueueCommand, [queue]);
  }

  deleteAllQueues(){
    return this.db.executeSql(this.deleteAllQueuesCommand);
  }

}

module.exports = Manager;
