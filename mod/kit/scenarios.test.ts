import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { finishReview } from './finish.ts'
import { useProviderForTests } from './forge.ts'
import { commitPush, publishReview } from './publish.ts'
import { routePr, selfClean } from './start.ts'
import { runFacts } from './state.ts'
import { reviewWorktrees } from './worktrees.ts'
import { fakeEngine } from '../testing/engine.ts'
import { repo } from '../testing/repo.ts'
import { fakeProvider } from '../forge/fake.ts'
import type { PullRequest, Review, Thread } from '../forge/types.ts'

afterEach(() => useProviderForTests(undefined))

function prRepo({ number = 7, author = 'bob', reviews = [], threads = [] }: { number?: number; author?: string; reviews?: Review[]; threads?: Thread[] } = {}) {
  const r = repo(); r.origin()
  const base = r.commit('a.txt', '1', 'base'); r.git('push', '-q', 'origin', 'main')
  r.git('switch', '-qc', 'feat'); const head = r.commit('b.txt', 'pr', 'pr'); r.git('push', '-q', 'origin', 'feat')
  r.git('switch', '-q', 'main'); r.git('branch', '-qD', 'feat')
  const pull: PullRequest = { number, title: 'T', author, headRef: 'feat', headSha: head, baseRef: 'main', state: 'open', merged: false, url: 'u', conflicted: false }
  const provider = fakeProvider({ me: 'alice', pulls: [pull], reviews: { [number]: reviews }, threads: { [number]: { threads, general: [] } } })
  useProviderForTests(provider)
  return { r, provider, head, base, pull }
}

function ownWithComment(head: string): { reviews: Review[]; threads: Thread[] } {
  const comment = { id: 'c1', author: 'carol', body: 'исправь', createdAt: '2026-10-01T10:00:00Z', path: 'b.txt', line: 1, commitSha: head, reviewId: 'r1' }
  return {
    reviews: [{ id: 'r1', author: 'carol', state: 'changes', body: '', commitSha: head, submittedAt: '2026-10-01T10:00:00Z', dismissed: false }],
    threads: [{ id: 'r1:b.txt:1', path: 'b.txt', line: 1, commitSha: head, comments: [comment], resolved: false }],
  }
}

test('ревью в основном дереве с изменениями: stash → PR → finish — прежняя ветка, изменения на месте, ветки ревью нет', async () => {
  const { r } = prRepo()
  r.git('switch', '-qc', 'work'); writeFileSync(join(r.dir, 'a.txt'), 'wip')
  const { $, asked } = fakeEngine({ root: r.dir })
  assert.match(await routePr($, 7, 'return'), /stash «review-kit: pr-7/)
  assert.equal(r.git('branch', '--show-current'), 'feat')
  assert.match(await finishReview($, 7), /дерево на work, ветка feat удалена, изменения из stash возвращены/)
  assert.equal(r.git('branch', '--show-current'), 'work')
  assert.equal(readFileSync(join(r.dir, 'a.txt'), 'utf8'), 'wip')
  assert.equal(r.git('branch', '--list', 'feat'), '')
  assert.equal(r.git('stash', 'list'), '')
  assert.deepEqual(asked, [])
})

test('review_finish своего PR: ветка остаётся, подсказка про stash', async () => {
  const setup = prRepo({ number: 8, author: 'alice' })
  const { reviews, threads } = ownWithComment(setup.head)
  useProviderForTests(fakeProvider({ me: 'alice', pulls: [{ ...setup.pull, number: 8 }], reviews: { 8: reviews }, threads: { 8: { threads, general: [] } } }))
  const { r } = setup
  r.git('switch', '-qc', 'work'); writeFileSync(join(r.dir, 'a.txt'), 'wip')
  const { $ } = fakeEngine({ root: r.dir })
  assert.match(await routePr($, 8, 'return'), /stash «review-kit: pr-8/)
  assert.match(await finishReview($, 8), /изменения с ветки work — в stash «review-kit: pr-8 .*»: вернуться на ветку и git stash pop/)
  assert.equal(r.git('branch', '--show-current'), 'feat')
})

test('commit_push: файл вне списка — отказ без вопроса; «Нет» — коммита нет; «Да» — коммит на origin', async () => {
  const setup = prRepo({ number: 8, author: 'alice' })
  const { reviews, threads } = ownWithComment(setup.head)
  useProviderForTests(fakeProvider({ me: 'alice', pulls: [{ ...setup.pull, number: 8 }], reviews: { 8: reviews }, threads: { 8: { threads, general: [] } } }))
  const { r } = setup
  const { $, asked } = fakeEngine({ root: r.dir, answers: ['Нет', 'Да'] })
  await routePr($, 8, 'return')
  writeFileSync(join(r.dir, 'b.txt'), 'fixed'); writeFileSync(join(r.dir, 'a.txt'), 'чужое')
  assert.match(await commitPush($, { pr: 8, message: 'fix: поправил', paths: ['b.txt'] }), /not done: изменены файлы вне списка раунда[\s\S]*a\.txt/)
  assert.deepEqual(asked, [])
  r.git('checkout', '-q', '--', 'a.txt')
  const before = r.git('rev-parse', 'HEAD')
  assert.equal(await commitPush($, { pr: 8, message: 'fix: поправил', paths: ['b.txt'] }), 'not done: пользователь отказал')
  assert.equal(r.git('rev-parse', 'HEAD'), before)
  assert.match(await commitPush($, { pr: 8, message: 'fix: поправил', paths: ['b.txt'] }), /^pushed: \w+ в feat$/)
  assert.equal(r.git('rev-parse', 'origin/feat'), r.git('rev-parse', 'HEAD'))
  assert.equal(asked.length, 2)
})

test('review_publish: устаревший снимок — отказ до вопроса; «Нет» — не опубликовано; «Да» — черновик у хостинга; ничего не выбрано — одобрение', async () => {
  const { r, provider, pull } = prRepo()
  const { $, asked } = fakeEngine({ root: r.dir, answers: ['Нет', 'Да', 'Да'] })
  await routePr($, 7, 'return')
  const dir = join(r.dir, '.review-kit/run/7')
  const finding = { id: 'A-1', role: 'correctness', file: 'b.txt', line: 1, severity: 'blocking', category: 'regression', confidence: 90, problem: 'p', failureScenario: 's', verdict: 'confirmed' }
  writeFileSync(join(dir, 'findings.json'), JSON.stringify({ findings: [finding], belowBar: [], dropped: [], unconfirmed: [], notChecked: [] }))
  writeFileSync(join(dir, 'texts.json'), JSON.stringify({ comments: { 'A-1': 'исправь' } }))
  const head = pull.headSha
  pull.headSha = 'deadbeefdeadbeef'
  assert.match(await publishReview($, { pr: 7, ids: ['A-1'] }), /^not published: PR обновился после снимка: голова была/)
  assert.deepEqual(asked, [])
  pull.headSha = head
  assert.equal(await publishReview($, { pr: 7, ids: ['A-1'] }), 'not published: пользователь отказал (вердикт Changes requested)')
  assert.equal(provider.published.length, 0)
  assert.match(await publishReview($, { pr: 7, ids: ['A-1'] }), /^published: fake:\/\/7\/review\/1 \(вердикт Changes requested\)/)
  assert.deepEqual(provider.published[0].draft, { verdict: 'request-changes', body: 'Нужны правки.', comments: [{ path: 'b.txt', line: 1, body: 'исправь' }] })
  assert.match(await publishReview($, { pr: 7, ids: [] }), /вердикт Approved\)$/)
  assert.equal(asked.at(-1), 'Одобрить PR 7 без комментариев?')
  assert.equal(provider.published[1].draft.verdict, 'approve')
})

test('review_publish из расширения: source вне ext/ — отказ до вопроса; ext/x — спрашивает и публикует summary', async () => {
  const { r, provider } = prRepo()
  const { $, asked } = fakeEngine({ root: r.dir, answers: ['Нет', 'Да'] })
  await routePr($, 7, 'return')
  const dir = join(r.dir, '.review-kit/run/7')
  const finding = { id: 'A-1', role: 'correctness', file: 'b.txt', line: 1, severity: 'non-blocking', confidence: 90, problem: 'p', failureScenario: 's', verdict: 'confirmed' }
  writeFileSync(join(dir, 'findings.json'), JSON.stringify({ findings: [], belowBar: [], dropped: [], unconfirmed: [], notChecked: [] }))
  mkdirSync(join(dir, 'ext/x'), { recursive: true })
  writeFileSync(join(dir, 'ext/x/findings.json'), JSON.stringify({ findings: [finding] }))
  writeFileSync(join(dir, 'ext/x/texts.json'), JSON.stringify({ comments: { 'A-1': 'поправь' }, summary: 'Итог расширения' }))
  assert.match(await publishReview($, { pr: 7, ids: 'all', source: '../7', verdict: 'request-changes' }), /^not published: source/)
  assert.match(await publishReview($, { pr: 7, ids: 'all', source: '/tmp/x', verdict: 'request-changes' }), /^not published: source/)
  assert.match(await publishReview($, { pr: 7, ids: 'all', source: 'ext/x' }), /^not published: с source нужен verdict/)
  assert.deepEqual(asked, [])
  assert.equal(await publishReview($, { pr: 7, ids: 'all', source: 'ext/x', verdict: 'request-changes' }), 'not published: пользователь отказал (вердикт Changes requested)')
  assert.match(await publishReview($, { pr: 7, ids: ['A-1'], source: 'ext/x', verdict: 'request-changes' }), /^published: /)
  assert.match(provider.published[0].draft.body, /Итог расширения/)
  assert.equal(asked.length, 2)
})

test('/pr N fix: чужой PR — отказ, дерево не тронуто; свой — прогон fix', async () => {
  const foreign = prRepo()
  const one = fakeEngine({ root: foreign.r.dir })
  assert.match(await routePr(one.$, 7, 'return', 'fix'), /не ваш/)
  assert.equal(foreign.r.git('branch', '--show-current'), 'main')
  assert.deepEqual(one.asked, [])

  const own = prRepo({ author: 'alice' })
  const two = fakeEngine({ root: own.r.dir })
  assert.match(await routePr(two.$, 7, 'return', 'fix'), /правки/)
  assert.equal((await runFacts(two.$))?.scenario, 'fix')
})

test('/pr N feedback без замечаний — отказ без переключения; /pr N review своего — только отчёт', async () => {
  const { r } = prRepo({ author: 'alice' })
  const { $ } = fakeEngine({ root: r.dir })
  assert.equal(await routePr($, 7, 'return', 'feedback'), 'У PR 7 нет замечаний. Правки: /pr 7 fix')
  assert.equal(r.git('branch', '--show-current'), 'main')
  assert.match(await routePr($, 7, 'return', 'review'), /свой — только отчёт/)
  assert.equal((await runFacts($))?.scenario, 'review')
})

test('/pr N второй раз в той же сессии — прогон продолжается тем же скиллом', async () => {
  const { r } = prRepo()
  const { $ } = fakeEngine({ root: r.dir })
  await routePr($, 7, 'return')
  assert.match(await routePr($, 7, 'return'), /Use the review-kit:pr-review-run skill for PR 7/)
})

test('review_worktree: явные номера — в дереве ревью (/pr N review), без номеров — сценарий по статусу', async () => {
  const { r } = prRepo()
  const { $ } = fakeEngine({ root: r.dir })
  const named = await reviewWorktrees($, [7])
  assert.equal(named.trees.length, 1)
  assert.match(named.trees[0].command, /'\/pr 7 review'$/)
})

test('selfClean: живой прогон не тронут, брошенные папки и старые гайды убраны', async () => {
  const r = repo(); r.commit('a.txt', '1', 'base')
  useProviderForTests(fakeProvider({ me: 'alice', pulls: [] }))
  const session = (n: number, status: string) => {
    mkdirSync(join(r.dir, `.review-kit/run/${n}`), { recursive: true })
    writeFileSync(join(r.dir, `.review-kit/run/${n}/session.json`), JSON.stringify({ sessionId: 'other', status }))
  }
  session(1, 'active'); session(2, 'done'); session(3, 'active')
  mkdirSync(join(r.dir, '.review-kit/guide'), { recursive: true })
  writeFileSync(join(r.dir, '.review-kit/guide/pr-5.md'), 'old'); writeFileSync(join(r.dir, '.review-kit/guide/pr-6.md'), 'fresh')
  const { $ } = fakeEngine({ root: r.dir })
  await $.process.run(['touch', '-d', '2 days ago', join(r.dir, '.review-kit/run/3/session.json'), join(r.dir, '.review-kit/guide/pr-5.md')])
  assert.equal(await selfClean($), 'Убрано за прошлыми прогонами: папок прогонов 2, гайдов 1.')
  const left = (await $.process.run(['ls', '-1', join(r.dir, '.review-kit/run'), join(r.dir, '.review-kit/guide')])).stdout
  assert.match(left, /^1$/m)
  assert.doesNotMatch(left, /^[23]$/m)
  assert.match(left, /pr-6\.md/)
  assert.doesNotMatch(left, /pr-5\.md/)
})
