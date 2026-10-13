import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { forgejo, parseRemote } from './forgejo.ts'
import type { HttpInit, HttpResponse } from './types.ts'

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const API = 'https://git.example.org/api/v1/repos/team/app'

type Route = HttpResponse | Error
function fakeHttp(routes: Record<string, Route | Route[]>) {
  const calls: Array<{ url: string; init?: HttpInit }> = []
  const http = async (url: string, init?: HttpInit): Promise<HttpResponse> => {
    calls.push({ url, init })
    const key = `${init?.method ?? 'GET'} ${url}`
    const route = routes[key]
    const next = Array.isArray(route) ? route.shift() : route
    if (!next) throw new Error(`нет маршрута ${key}`)
    if (next instanceof Error) throw next
    return next
  }
  return { http, calls }
}
const ok = (text: string): HttpResponse => ({ status: 200, ok: true, headers: {}, text })
const provider = (routes: Record<string, Route | Route[]>) => {
  const { http, calls } = fakeHttp(routes)
  const sleeps: number[] = []
  const instance = forgejo.create({ repo: { host: 'git.example.org', owner: 'team', repo: 'app' }, token: 'T', http, sleep: async ms => { sleeps.push(ms) } })
  return { instance, calls, sleeps }
}
const READ_ROUTES = {
  [`GET ${API}/pulls/42/reviews?page=1&limit=50`]: ok(fixture('reviews.json')),
  [`GET ${API}/pulls/42/reviews/11/comments`]: ok(fixture('review-comments-11.json')),
  [`GET ${API}/pulls/42/reviews/12/comments`]: ok(fixture('review-comments-12.json')),
  [`GET ${API}/pulls/42/reviews/13/comments`]: ok('[]'),
  [`GET ${API}/pulls/42/reviews/15/comments`]: ok('[]'),
  [`GET ${API}/issues/42/comments?page=1&limit=50`]: ok(fixture('issue-comments.json')),
}

test('parseRemote: формы remote', () => {
  const want = { host: 'git.example.org', owner: 'team', repo: 'app' }
  assert.deepEqual(parseRemote('https://git.example.org/team/app.git'), want)
  assert.deepEqual(parseRemote('https://git.example.org:3000/team/app/'), want)
  assert.deepEqual(parseRemote('ssh://git@git.example.org:2222/team/app.git'), want)
  assert.deepEqual(parseRemote('git@git.example.org:team/app.git'), want)
  assert.deepEqual(parseRemote('git.example.org/team/app'), null)
  assert.deepEqual(parseRemote('https://git.example.org/app'), null)
  assert.deepEqual(parseRemote(''), null)
})

test('detect: чужие известные хостинги не наши', () => {
  assert.equal(forgejo.detect('git@github.com:team/app.git'), null)
  assert.equal(forgejo.detect('https://GitLab.com/team/app'), null)
  assert.deepEqual(forgejo.detect('git@git.example.org:team/app.git'), { host: 'git.example.org', owner: 'team', repo: 'app' })
})

test('getPull: маппинг и заголовок авторизации', async () => {
  const { instance, calls } = provider({ [`GET ${API}/pulls/42`]: ok(fixture('pull.json')) })
  assert.deepEqual(await instance.getPull(42), {
    number: 42, title: 'Добавить экспорт', author: 'Bob', headRef: 'feature/export', headSha: 'aaa111', baseRef: 'main',
    state: 'open', merged: false, url: 'https://git.example.org/team/app/pulls/42',
  })
  assert.equal(calls[0].init?.headers?.Authorization, 'token T')
})

test('listReviews: состояния, черновик, снятое, без REQUEST_REVIEW, призрак', async () => {
  const { instance } = provider(READ_ROUTES)
  const reviews = await instance.listReviews(42)
  assert.deepEqual(reviews.map(r => [r.id, r.author, r.state, r.dismissed]), [
    ['11', 'alice', 'changes', false], ['12', 'carol', 'approved', true], ['13', 'alice', 'pending', false], ['15', '', 'comment', false],
  ])
  assert.equal(reviews[2].submittedAt, '')
})

test('listThreads: группировка, порядок, resolved, общие комментарии', async () => {
  const { instance } = provider(READ_ROUTES)
  const { threads, general } = await instance.listThreads(42)
  assert.equal(threads.length, 2)
  const [a, b] = threads
  assert.deepEqual([a.id, a.path, a.line, a.commitSha, a.resolved], ['11:src/a.ts:5', 'src/a.ts', 5, 'aaa000', false])
  assert.deepEqual(a.comments.map(c => [c.id, c.author, c.reviewId]), [['100', 'alice', '11'], ['101', 'Bob', '11']])
  assert.deepEqual([b.id, b.resolved], ['11:src/b.ts:9', true])
  assert.deepEqual(general, [{ id: '200', author: 'carol', body: 'Когда релиз?', createdAt: '2026-10-02T09:00:00Z' }])
})

test('пагинация: 50 + 3 ревью — две страницы, ничего не теряется', async () => {
  const review = (id: number) => ({ id, user: { login: 'x' }, state: 'COMMENT', body: '', commit_id: 'c', submitted_at: '2026-10-01T00:00:00Z', dismissed: false })
  const page1 = Array.from({ length: 50 }, (_, i) => review(i + 1))
  const page2 = [51, 52, 53].map(review)
  const { instance, calls } = provider({
    [`GET ${API}/pulls/42/reviews?page=1&limit=50`]: ok(JSON.stringify(page1)),
    [`GET ${API}/pulls/42/reviews?page=2&limit=50`]: ok(JSON.stringify(page2)),
  })
  assert.equal((await instance.listReviews(42)).length, 53)
  assert.equal(calls.length, 2)
})

test('currentUser: один запрос на сессию', async () => {
  const { instance, calls } = provider({ ['GET https://git.example.org/api/v1/user']: ok('{"login":"alice"}') })
  assert.equal(await instance.currentUser(), 'alice')
  assert.equal(await instance.currentUser(), 'alice')
  assert.equal(calls.length, 1)
})

test('listPulls: одна страница до 50, state передаётся', async () => {
  const { instance, calls } = provider({ [`GET ${API}/pulls?state=closed&page=1&limit=50`]: ok(`[${fixture('pull.json')}]`) })
  assert.equal((await instance.listPulls('closed'))[0].number, 42)
  assert.equal(calls.length, 1)
})

test('ошибка HTTP — сообщение с кодом и путём', async () => {
  const { instance } = provider({ [`GET ${API}/pulls/9`]: { status: 404, ok: false, headers: {}, text: '{"message":"not found"}' } })
  await assert.rejects(instance.getPull(9), /GET \/repos\/team\/app\/pulls\/9: HTTP 404/)
})

test('сетевая ошибка — сообщение «сеть»', async () => {
  const { instance } = provider({ [`GET ${API}/pulls/9`]: new Error('ECONNRESET') })
  await assert.rejects(instance.getPull(9), /pulls\/9: сеть: .*ECONNRESET/)
})

test('pullRef и capabilities', () => {
  const { instance } = provider({})
  assert.equal(instance.pullRef(42), 'refs/pull/42/head')
  assert.deepEqual(instance.capabilities, { inline: true, requestChanges: true })
  assert.equal(instance.name, 'Forgejo/Gitea')
})

const DRAFT = { verdict: 'request-changes' as const, body: 'Нужны правки', comments: [{ path: 'src/a.ts', line: 5, body: 'null' }] }
const REVIEWS_BEFORE = () => ok('[{"id":11,"user":{"login":"alice"},"state":"COMMENT","body":"старое","commit_id":"c","submitted_at":"2026-10-01T00:00:00Z"}]')
const REVIEWS_AFTER = () => ok('[{"id":11,"user":{"login":"alice"},"state":"COMMENT","body":"старое","commit_id":"c","submitted_at":"2026-10-01T00:00:00Z"},{"id":16,"user":{"login":"Alice"},"state":"REQUEST_CHANGES","body":"Нужны правки","commit_id":"c","submitted_at":"2026-10-05T00:00:00Z","html_url":"https://git.example.org/team/app/pulls/42#review-16"}]')
const USER = ok('{"login":"alice"}')

test('publishReview: событие, new_position, ссылка', async () => {
  const { instance, calls } = provider({
    [`GET ${API}/pulls/42/reviews?page=1&limit=50`]: REVIEWS_BEFORE(),
    [`POST ${API}/pulls/42/reviews`]: ok('{"id":16,"html_url":"https://git.example.org/team/app/pulls/42#review-16"}'),
  })
  assert.deepEqual(await instance.publishReview(42, DRAFT), { url: 'https://git.example.org/team/app/pulls/42#review-16' })
  const post = calls.find(c => c.init?.method === 'POST')
  assert.deepEqual(JSON.parse(post?.init?.body ?? ''), { body: 'Нужны правки', event: 'REQUEST_CHANGES', comments: [{ path: 'src/a.ts', new_position: 5, body: 'null' }] })
})

test('publishReview: approve и comment маппятся на APPROVED и COMMENT', async () => {
  for (const [verdict, event] of [['approve', 'APPROVED'], ['comment', 'COMMENT']] as const) {
    const { instance, calls } = provider({ [`GET ${API}/pulls/42/reviews?page=1&limit=50`]: ok('[]'), [`POST ${API}/pulls/42/reviews`]: ok('{"html_url":"u"}') })
    await instance.publishReview(42, { verdict, body: '', comments: [] })
    assert.equal(JSON.parse(calls[1].init?.body ?? '').event, event)
  }
})

test('publishReview: ошибка HTTP — без reconcile', async () => {
  const { instance, calls } = provider({
    [`GET ${API}/pulls/42/reviews?page=1&limit=50`]: REVIEWS_BEFORE(),
    [`POST ${API}/pulls/42/reviews`]: { status: 422, ok: false, headers: {}, text: 'bad' },
  })
  await assert.rejects(instance.publishReview(42, DRAFT), /HTTP 422/)
  assert.equal(calls.length, 2)
})

test('publishReview: обрыв связи, ревью создано — находит его, не публикует снова', async () => {
  const { instance, sleeps, calls } = provider({
    [`GET ${API}/pulls/42/reviews?page=1&limit=50`]: [REVIEWS_BEFORE(), REVIEWS_AFTER()],
    [`POST ${API}/pulls/42/reviews`]: new Error('socket hang up'),
    ['GET https://git.example.org/api/v1/user']: USER,
  })
  assert.deepEqual(await instance.publishReview(42, DRAFT), { url: 'https://git.example.org/team/app/pulls/42#review-16' })
  assert.deepEqual(sleeps, [])
  assert.equal(calls.filter(c => c.init?.method === 'POST').length, 1)
})

test('publishReview: обрыв связи, ревью не нашлось за 3 попытки — статус неизвестен', async () => {
  const { instance, sleeps } = provider({
    [`GET ${API}/pulls/42/reviews?page=1&limit=50`]: [REVIEWS_BEFORE(), REVIEWS_BEFORE(), new Error('timeout'), REVIEWS_BEFORE()],
    [`POST ${API}/pulls/42/reviews`]: new Error('socket hang up'),
    ['GET https://git.example.org/api/v1/user']: USER,
  })
  await assert.rejects(instance.publishReview(42, DRAFT), /статус публикации неизвестен — проверьте PR 42 перед повтором/)
  assert.deepEqual(sleeps, [5000, 5000])
})

test('publishReplies: в тред и общим комментарием с цитатой', async () => {
  const { instance, calls } = provider({
    [`POST ${API}/pulls/42/reviews/11/comments`]: ok('{}'),
    [`POST ${API}/issues/42/comments`]: ok('{}'),
  })
  await instance.publishReplies(42, [{ threadId: '11:src/a.ts:5', body: 'Сделано' }, { quote: 'Когда релиз?', body: 'В пятницу' }])
  assert.deepEqual(JSON.parse(calls[0].init?.body ?? ''), { path: 'src/a.ts', new_position: 5, body: 'Сделано' })
  assert.deepEqual(JSON.parse(calls[1].init?.body ?? ''), { body: '> Когда релиз?\n\nВ пятницу' })
})

test('publishReplies: ошибка посередине — сколько уже отправлено', async () => {
  const { instance } = provider({
    [`POST ${API}/pulls/42/reviews/11/comments`]: ok('{}'),
    [`POST ${API}/issues/42/comments`]: { status: 500, ok: false, headers: {}, text: 'oops' },
  })
  await assert.rejects(instance.publishReplies(42, [{ threadId: '11:src/a.ts:5', body: 'a' }, { quote: 'q', body: 'b' }]), /HTTP 500.*уже отправлено 1 из 2/s)
})

test('publishReplies: битый threadId — ошибка до отправки', async () => {
  const { instance, calls } = provider({})
  await assert.rejects(instance.publishReplies(42, [{ threadId: 'xyz', body: 'a' }]), /неизвестный тред xyz/)
  assert.equal(calls.length, 0)
})
