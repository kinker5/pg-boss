var assert = require('chai').assert;
var PgBoss = require('../src/index');
var helper = require('./testHelper');
var Promise = require('bluebird');
const domain = require('domain');

describe('database', function(){

    it('should fail on invalid database host', function(finished){

        this.timeout(10000);

        var boss = new PgBoss('postgres://bobby:tables@wat:12345/northwind');

        boss.start()
            .then(() => {
                assert(false);
                return boss.stop();
            })
            .then(() => finished())
            .catch(() => {
                assert(true);
                finished();
            });
    });

    it('connection count does not exceed configured pool size', function(finished){

        this.timeout(5000);

        const listenerCount = 100;
        const poolSize = 5;

        let listeners = [];
        for(let x = 0; x<listenerCount; x++)
            listeners[x] = x;

        let boss;
        let database;
        let prevConnectionCount;

        helper.start({poolSize})
            .then(b => boss = b)
            .then(() => helper.getDb())
            .then(db => database = db)
            .then(() => countConnections(database))
            .then(connectionCount => prevConnectionCount = connectionCount)
            .then(() => Promise.all(
                    listeners.map((val, index) => boss.subscribe(`job${index}`, () => {}))
                )
            )
            .then(() => new Promise(resolve => setTimeout(resolve, 3000)))
            .then(() => countConnections(database))
            .then(connectionCount => {
                let newConnections = connectionCount - prevConnectionCount;
                console.log(`listeners: ${listenerCount}  pool size: ${poolSize}`);
                console.log('connections:');
                console.log(`  before subscribing: ${prevConnectionCount}  now: ${connectionCount}  new: ${newConnections}`);
                assert(newConnections <= poolSize);
            })
            .then(() => boss.stop())
            .then(() => finished());


        function countConnections(db) {
            return db.executeSql('SELECT count(*) as connections FROM pg_stat_activity')
                .then(result => parseFloat(result.rows[0].connections));
        }

    });

});
