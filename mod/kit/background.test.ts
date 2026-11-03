import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterFunnel, launchReview, parseAgents, readMarker, reviewButtons, verdictOf, type AgentSession } from './background.ts'
import { dropReviewWorktree } from './finish.ts'
import { fakeEngine, type FakeClaude } from '../testing/engine.ts'
import { repo } from '../testing/repo.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'review-kit-bg-'))
}

test('вердикт: есть блокирующая → changes', () => {
  assert.deepEqual(verdictOf([{ severity: 'blocking' }, { severity: 'non-blocking' }]), { verdict: 'changes', blocking: 1, nonBlocking: 1 })
})

test('вердикт: только неблокирующие → comments', () => {
  assert.deepEqual(verdictOf([{ severity: 'non-blocking' }]), { verdict: 'comments', blocking: 0, nonBlocking: 1 })
})

test('вердикт: пусто → approved', () => {
  assert.deepEqual(verdictOf([]), { verdict: 'approved', blocking: 0, nonBlocking: 0 })
})

test('метка: нет файла или битый JSON → undefined, верная — читается', async () => {
  const root = tempDir()
  const { $ } = fakeEngine({ root })
  assert.equal(await readMarker($, root), undefined)
  mkdirSync(join(root, '.review-kit'), { recursive: true })
  writeFileSync(join(root, '.review-kit/background.json'), 'oops')
  assert.equal(await readMarker($, root), undefined)
  writeFileSync(join(root, '.review-kit/background.json'), JSON.stringify({ pr: 'x', mainSessionId: 1 }))
  assert.equal(await readMarker($, root), undefined)
  writeFileSync(join(root, '.review-kit/background.json'), JSON.stringify({ pr: 7, mainSessionId: 'main-id' }))
  assert.deepEqual(await readMarker($, root), { pr: 7, mainSessionId: 'main-id' })
})

function withFindings(findings: Array<{ severity: string }>) {
  const r = repo(); r.commit('a.txt', '1', 'base')
  mkdirSync(join(r.dir, '.review-kit/run/7'), { recursive: true })
  writeFileSync(join(r.dir, '.review-kit/run/7/findings.json'), JSON.stringify({ findings, belowBar: [], unconfirmed: [] }))
  return r
}

test('после воронки: result.json, в фоновой сессии — /color по вердикту', async () => {
  const r = withFindings([{ severity: 'blocking' }])
  writeFileSync(join(r.dir, '.review-kit/background.json'), JSON.stringify({ pr: 7, mainSessionId: 'main-id' }))
  const { $, commands } = fakeEngine({ root: r.dir })
  await afterFunnel($, 7)
  assert.deepEqual(JSON.parse(readFileSync(join(r.dir, '.review-kit/run/7/result.json'), 'utf8')), { verdict: 'changes', blocking: 1, nonBlocking: 0 })
  assert.deepEqual(commands, [{ command: 'color', args: 'red' }])
})

test('после воронки: без метки /color не вызывается; сбой /color — в лог', async () => {
  const r = withFindings([])
  const plain = fakeEngine({ root: r.dir })
  await afterFunnel(plain.$, 7)
  assert.deepEqual(plain.commands, [])
  writeFileSync(join(r.dir, '.review-kit/background.json'), JSON.stringify({ pr: 7, mainSessionId: 'main-id' }))
  const failing = fakeEngine({ root: r.dir, command: async () => { throw new Error('busy') } })
  await afterFunnel(failing.$, 7)
  await new Promise(resolve => setImmediate(resolve))
  assert.match(failing.logs.join('\n'), /\/color не прошёл: Error: busy/)
})

const AGENTS_SAMPLE = JSON.stringify([
  { pid: 1, id: '80f1b572', cwd: '/p/.claude/worktrees/pr-7-feat', kind: 'background', startedAt: 1, sessionId: '80f1b572-b041-4ceb-97c7-77810fc91b05', name: 'PR-7', status: 'waiting', waitingFor: 'input needed', state: 'blocked' },
  { id: '4fc0dfda', cwd: '/p', kind: 'background', startedAt: 1, sessionId: '4fc0dfda-0143-4fa0-9d91-7a26006c4c09', name: 'other', state: 'done' },
  { pid: 2, cwd: '/p', kind: 'interactive', startedAt: 1, sessionId: 'd7abd1df-2a30-4f23-9659-5313ba7806b1', name: 'main', status: 'busy' },
])

test('parseAgents: фоновые сессии с полями; интерактивные и мусор — нет', () => {
  assert.deepEqual(parseAgents(AGENTS_SAMPLE), [
    { id: '80f1b572', sessionId: '80f1b572-b041-4ceb-97c7-77810fc91b05', name: 'PR-7', cwd: '/p/.claude/worktrees/pr-7-feat', status: 'waiting', waitingFor: 'input needed', state: 'blocked' },
    { id: '4fc0dfda', sessionId: '4fc0dfda-0143-4fa0-9d91-7a26006c4c09', name: 'other', cwd: '/p', status: null, waitingFor: null, state: 'done' },
  ])
  assert.deepEqual(parseAgents('oops'), [])
  assert.deepEqual(parseAgents('{"a":1}'), [])
})

function fakeClaude(path: string, { bg = { exitCode: 0, stdout: 'backgrounded · abc12345 · PR-7\n', stderr: '' }, listed = true } = {}) {
  const calls: Array<{ argv: string[]; cwd: string; marker: boolean }> = []
  const claude: FakeClaude = (argv, cwd) => {
    calls.push({ argv, cwd, marker: argv[1] === '--bg' && (() => { try { readFileSync(join(path, '.review-kit/background.json')); return true } catch { return false } })() })
    if (argv[1] === '--bg') return bg
    if (argv[1] === 'agents') return { exitCode: 0, stdout: JSON.stringify(listed ? [{ id: 'abc12345', sessionId: 'abc12345-full', name: 'PR-7', cwd: path, kind: 'background', status: 'busy', state: 'working' }] : []), stderr: '' }
    return { exitCode: 1, stdout: '', stderr: 'unexpected' }
  }
  return { claude, calls }
}

test('launchReview: метка до запуска, claude --bg в дереве, сессия найдена', async () => {
  const path = tempDir()
  const { claude, calls } = fakeClaude(path)
  const { $ } = fakeEngine({ root: tempDir(), claude })
  const result = await launchReview($, { pr: 7, path, prompt: '/pr 7 review' })
  assert.deepEqual(calls[0], { argv: ['claude', '--bg', '-n', 'PR-7', '--permission-mode', 'auto', '/pr 7 review'], cwd: path, marker: true })
  assert.deepEqual(JSON.parse(readFileSync(join(path, '.review-kit/background.json'), 'utf8')), { pr: 7, mainSessionId: 'test-session' })
  assert.ok('session' in result && result.session.id === 'abc12345' && result.session.name === 'PR-7')
})

test('launchReview: claude --bg отказал — ошибка с stderr', async () => {
  const path = tempDir()
  const { claude } = fakeClaude(path, { bg: { exitCode: 1, stdout: '', stderr: 'Workspace not trusted. Run claude here first.' } })
  const { $ } = fakeEngine({ root: tempDir(), claude })
  const result = await launchReview($, { pr: 7, path, prompt: '/pr 7 review' })
  assert.ok('error' in result)
  assert.match(result.error, /Workspace not trusted/)
})

test('launchReview: нет claude — ошибка; сессия не появилась — ошибка после 3 проверок', async () => {
  const path = tempDir()
  const missing = await launchReview(fakeEngine({ root: tempDir() }).$, { pr: 7, path, prompt: '/pr 7 review' })
  assert.ok('error' in missing && /command not found/.test(missing.error))
  const { claude, calls } = fakeClaude(path, { listed: false })
  const result = await launchReview(fakeEngine({ root: tempDir(), claude }).$, { pr: 7, path, prompt: '/pr 7 review' })
  assert.ok('error' in result && /фоновая сессия не появилась/.test(result.error))
  assert.equal(calls.filter(call => call.argv[1] === 'agents').length, 3)
})

function reviewTree(pr: number, { marker = true, verdict }: { marker?: boolean; verdict?: string } = {}): string {
  const path = tempDir()
  if (marker) {
    mkdirSync(join(path, '.review-kit'), { recursive: true })
    writeFileSync(join(path, '.review-kit/background.json'), JSON.stringify({ pr, mainSessionId: 'main-id' }))
  }
  if (verdict) {
    mkdirSync(join(path, `.review-kit/run/${pr}`), { recursive: true })
    writeFileSync(join(path, `.review-kit/run/${pr}/result.json`), JSON.stringify({ verdict, blocking: 0, nonBlocking: 0 }))
  }
  return path
}

const agent = (pr: number, cwd: string, extra: Partial<AgentSession> = {}): AgentSession => ({ id: `id${pr}`, sessionId: `sid${pr}`, name: `PR-${pr}`, cwd, status: 'waiting', waitingFor: 'input needed', state: 'blocked', ...extra })

test('кнопки: только законченные ревью кита (result.json), ждущие ответа; порядок — по цвету, затем по номеру', async () => {
  const { $ } = fakeEngine({ root: tempDir() })
  const sessions = [
    agent(9, reviewTree(9)),
    agent(8, reviewTree(8, { verdict: 'changes' }), { status: 'busy', waitingFor: null, state: 'working' }),
    agent(12, reviewTree(12, { marker: false, verdict: 'changes' })),
    agent(5, reviewTree(5, { verdict: 'approved' })),
    agent(7, reviewTree(7, { verdict: 'changes' })),
    agent(6, reviewTree(6, { verdict: 'comments' })),
    agent(3, reviewTree(3, { verdict: 'changes' }), { waitingFor: 'permission prompt' }),
    { ...agent(4, reviewTree(4, { verdict: 'changes' })), name: 'PR-4 other' },
  ]
  assert.deepEqual(await reviewButtons($, sessions), [
    { pr: 7, id: 'id7', sessionId: 'sid7', color: 'red' },
    { pr: 6, id: 'id6', sessionId: 'sid6', color: 'yellow' },
    { pr: 5, id: 'id5', sessionId: 'sid5', color: 'green' },
  ])
})

test('кнопки: метка другого PR в дереве — не наша сессия', async () => {
  const { $ } = fakeEngine({ root: tempDir() })
  assert.deepEqual(await reviewButtons($, [agent(7, reviewTree(8, { verdict: 'changes' }))]), [])
})

test('review_finish в дереве фонового ревью: дерево оставлено до следующего /pr', async () => {
  const r = repo(); r.commit('a.txt', '1', 'base')
  const tree = join(r.dir, '.claude/worktrees/pr-7-feat')
  r.git('worktree', 'add', '-q', '--detach', tree)
  mkdirSync(join(tree, '.review-kit'), { recursive: true })
  writeFileSync(join(tree, '.review-kit/background.json'), JSON.stringify({ pr: 7, mainSessionId: 'main-id' }))
  const { $ } = fakeEngine({ root: tree })
  assert.match(await dropReviewWorktree($) ?? '', /оставлен: ревью шло в фоне — уберётся при следующем \/pr в основном дереве/)
  assert.ok(existsSync(tree))
})

test('после воронки: /color откладывается на потом, не из хука инструмента', async () => {
  const r = withFindings([])
  writeFileSync(join(r.dir, '.review-kit/background.json'), JSON.stringify({ pr: 7, mainSessionId: 'main-id' }))
  const later: Array<() => void> = []
  const engine = fakeEngine({ root: r.dir })
  const $ = { ...engine.$, clock: { ...engine.$.clock, after: (_ms: number, fn: () => void) => { later.push(fn) } } } as typeof engine.$
  await afterFunnel($, 7)
  assert.deepEqual(engine.commands, [])
  later.forEach(fn => fn())
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(engine.commands, [{ command: 'color', args: 'green' }])
})
