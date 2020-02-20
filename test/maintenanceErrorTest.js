const helper = require('./testHelper')
const PgBoss = require('../')

describe('maintenance error handling', function () {
  this.retries(1)

  it('maintenance error handling works', function (done) {
    const defaults = {
      monitorStateIntervalMinutes: 1,
      maintenanceIntervalSeconds: 1
    }

    const config = { ...this.test.bossConfig, ...defaults }
    const boss = new PgBoss(config)

    const onError = (err) => {
      if (err && boss.isStarted) {
        boss.stop().then(() => done())
      } else {
        done()
      }
    }

    boss.on('error', onError)

    boss.start()
      .then(() => helper.getDb())
      .then(db => db.executeSql(`alter table ${config.schema}.job drop column state`))
      .catch(err => done(err))
  })

  it('state monitoring error handling works', function (done) {
    const defaults = {
      monitorStateIntervalSeconds: 1,
      maintenanceIntervalMinutes: 1
    }

    const config = { ...this.test.bossConfig, ...defaults }
    const boss = new PgBoss(config)

    const onError = (err) => {
      if (err && boss.isStarted) {
        boss.stop().then(() => done())
      } else {
        done()
      }
    }

    boss.on('error', onError)

    boss.start()
      .then(() => helper.getDb())
      .then(db => db.executeSql(`alter table ${config.schema}.job drop column state`))
      .catch(err => done(err))
  })
})
