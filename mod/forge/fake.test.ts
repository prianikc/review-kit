import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeProvider } from './fake.ts'

const PULL = { number: 7, title: 't', author: 'bob', headRef: 'f', headSha: 'h1', baseRef: 'main', state: 'open' as const, merged: false, url: 'u' }

test('fake отдаёт данные и запоминает публикации', async () => {
  const fake = fakeProvider({ me: 'alice', pulls: [PULL], reviews: { 7: [] } })
  assert.equal(await fake.currentUser(), 'alice')
  assert.deepEqual(await fake.listPulls('open'), [PULL])
  assert.deepEqual(await fake.getPull(7), PULL)
  assert.deepEqual(await fake.listReviews(7), [])
  assert.deepEqual(await fake.listThreads(7), { threads: [], general: [] })
  const draft = { verdict: 'comment' as const, body: 'b', comments: [] }
  assert.deepEqual(await fake.publishReview(7, draft), { url: 'fake://7/review/1' })
  await fake.publishReplies(7, [{ body: 'ok' }])
  assert.deepEqual(fake.published, [{ number: 7, draft }])
  assert.deepEqual(fake.replied, [{ number: 7, replies: [{ body: 'ok' }] }])
})

test('fake: неизвестный PR — ошибка', async () => {
  const fake = fakeProvider({ me: 'alice', pulls: [] })
  await assert.rejects(fake.getPull(1), /PR 1 не найден/)
})
