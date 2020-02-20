const assert = require('assert')
const helper = require('./testHelper')
const Promise = require('bluebird')

describe('archive', function () {
  const defaults = {
    archiveIntervalSeconds: 1,
    maintenanceIntervalSeconds: 1
  }

  it('should archive a completed job', async function () {
    const boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = 'archive-completed'

    const jobId = await boss.publish(queue)
    const job = await boss.fetch(queue)

    assert.strictEqual(job.id, jobId)

    await boss.complete(jobId)

    await Promise.delay(3000)

    const archivedJob = await helper.getArchivedJobById(jobId)

    assert.strictEqual(jobId, archivedJob.id)
    assert.strictEqual(queue, archivedJob.name)

    await boss.stop()
  })

  it('should archive a created job', async function () {
    const boss = await helper.start({ ...this.test.bossConfig, ...defaults })

    const queue = 'archive-created'

    const jobId = await boss.publish(queue, null, { retentionSeconds: 1 })

    await Promise.delay(5000)

    const archivedJob = await helper.getArchivedJobById(jobId)

    assert.strictEqual(jobId, archivedJob.id)
    assert.strictEqual(queue, archivedJob.name)

    await boss.stop()
  })
})
