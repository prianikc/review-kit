import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recheckBase } from './git.ts'
import { repo } from './testing/repo.ts'
import { binaryFiles, changedFiles, fileDiff, showFile, snapshot, treeEntries } from './git.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applySwitch, claudeCodeChanges, planSwitch } from './git.ts'
import { branchCandidates, commitRound, deleteBranches, foreignChanges, headShift, messageProblem, pushRound, reviewStashes, roundState, stashAction } from './git.ts'
import { createReviewWorktree, shellQuote, worktreeName } from './git.ts'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

test('recheckBase: моё ревью в истории — дельта от него', async () => {
  const r = repo()
  r.commit('a.txt', '1', 'base')
  const reviewed = r.commit('a.txt', '2', 'pr 1')
  const head = r.commit('a.txt', '3', 'pr 2')
  assert.deepEqual(await recheckBase(r.run, { lastCommit: reviewed, head, baseRef: 'main' }), { base: reviewed, mode: 'delta' })
})

test('recheckBase: история переписана — всё от merge-base с origin/<base>', async () => {
  const r = repo()
  const base = r.commit('a.txt', '1', 'base')
  r.git('update-ref', 'refs/remotes/origin/main', base)
  r.git('switch', '-qc', 'pr')
  const reviewed = r.commit('a.txt', '2', 'pr old')
  r.git('reset', '-q', '--hard', base)
  const head = r.commit('a.txt', '9', 'pr rewritten')
  const result = await recheckBase(r.run, { lastCommit: reviewed, head, baseRef: 'main' })
  assert.equal(result.base, base)
  assert.equal(result.mode, 'full')
  assert.match(result.note ?? '', /после rebase/)
})

test('recheckBase: базовой ветки нет — запасной origin/main; нет и его — ошибка', async () => {
  const r = repo()
  const base = r.commit('a.txt', '1', 'base')
  const head = r.commit('a.txt', '2', 'pr')
  await assert.rejects(recheckBase(r.run, { lastCommit: 'deadbeef', head, baseRef: 'gone' }), /не найдена база перепроверки/)
  r.git('update-ref', 'refs/remotes/origin/main', base)
  assert.equal((await recheckBase(r.run, { lastCommit: 'deadbeef', head, baseRef: 'gone' })).base, base)
})

test('changedFiles/treeEntries/showFile/fileDiff: пути с пробелами и кириллицей без кавычек', async () => {
  const r = repo()
  const base = r.commit('a.txt', '1\n', 'base')
  r.commit('папка/b c.txt', 'x\n', 'add')
  const head = r.commit('a.txt', '2\n', 'edit')
  assert.deepEqual(await changedFiles(r.run, base, head), ['a.txt', 'папка/b c.txt'])
  assert.equal((await treeEntries(r.run, head)).get('папка/b c.txt'), 'blob')
  assert.equal(await showFile(r.run, head, 'папка/b c.txt'), 'x\n')
  assert.match(await fileDiff(r.run, base, head, 'a.txt'), /^-1$\n^\+2$/m)
})

test('binaryFiles: бинарный файл узнаётся по numstat', async () => {
  const r = repo()
  const base = r.commit('a.txt', '1', 'base')
  writeFileSync(join(r.dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]))
  r.git('add', '-A'); r.git('commit', '-qm', 'bin')
  assert.deepEqual([...await binaryFiles(r.run, base, 'HEAD')], ['bin.dat'])
})

test('snapshot: коммит поверх HEAD с путями раунда, рабочий индекс не тронут', async () => {
  const r = repo()
  const head = r.commit('a.txt', '1', 'base')
  writeFileSync(join(r.dir, 'a.txt'), '2')
  writeFileSync(join(r.dir, 'other.txt'), 'не в раунде')
  const snap = await snapshot(r.run, { paths: ['a.txt'], indexFile: join(r.dir, '.git', 'rk-snapshot.index') })
  assert.equal(r.git('rev-parse', `${snap}^`), head)
  assert.equal(r.git('show', `${snap}:a.txt`), '2')
  assert.throws(() => r.git('show', `${snap}:other.txt`))
  assert.equal(r.git('diff', '--cached', '--name-only'), '')
})

test('claudeCodeChanges: настройки Claude Code на любой глубине', () => {
  assert.deepEqual(claudeCodeChanges(['src/a.ts', '.claude/settings.json', 'pkg/.mcp.json', 'x/CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude-plugin/plugin.json', 'docs/claude.md']),
    ['.claude/settings.json', 'pkg/.mcp.json', 'x/CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude-plugin/plugin.json'])
})

const SWITCH = { number: 7, headRef: 'feat', baseRef: 'main', own: false, pullRef: 'refs/pull/7/head' }

test('planSwitch + applySwitch: чужая ветка — локальная копия origin, база — merge-base', async () => {
  const r = repo(); r.origin()
  const base = r.commit('a.txt', '1', 'base'); r.git('push', '-q', 'origin', 'main')
  r.git('switch', '-qc', 'feat'); const head = r.commit('a.txt', '2', 'pr'); r.git('push', '-q', 'origin', 'feat')
  r.git('switch', '-q', 'main'); r.git('branch', '-qD', 'feat')
  const plan = await planSwitch(r.run, { ...SWITCH, headSha: head })
  assert.deepEqual([plan.target, plan.base, plan.detached, plan.baseFallback], [head, base, false, false])
  assert.equal(r.git('rev-parse', 'HEAD'), base)
  assert.deepEqual(await applySwitch(r.run, plan), { head, base, detached: false, baseFallback: false })
  assert.equal(r.git('branch', '--show-current'), 'feat')
})

test('ветки на origin нет — голова через refs/pull/N/head, detached', async () => {
  const r = repo(); r.origin()
  r.commit('a.txt', '1', 'base'); r.git('push', '-q', 'origin', 'main')
  r.git('switch', '-qc', 'tmp'); const head = r.commit('a.txt', '2', 'fork pr'); r.git('push', '-q', 'origin', 'HEAD:refs/pull/7/head')
  r.git('switch', '-q', 'main'); r.git('branch', '-qD', 'tmp')
  const switched = await applySwitch(r.run, await planSwitch(r.run, { ...SWITCH, headSha: head }))
  assert.deepEqual([switched.head, switched.detached], [head, true])
})

test('голова не совпала ни с веткой, ни с refs/pull — ошибка', async () => {
  const r = repo(); r.origin()
  r.commit('a.txt', '1', 'base'); r.git('push', '-q', 'origin', 'main')
  await assert.rejects(planSwitch(r.run, { ...SWITCH, headSha: 'f'.repeat(40) }), /на сервере нет ни ветки feat, ни refs\/pull\/7\/head/)
})

test('своя ветка разошлась с origin — ошибка; базовой ветки нет — от main', async () => {
  const r = repo(); r.origin()
  r.commit('a.txt', '1', 'base'); r.git('push', '-q', 'origin', 'main')
  r.git('switch', '-qc', 'feat'); const pushed = r.commit('a.txt', '2', 'pr'); r.git('push', '-q', 'origin', 'feat')
  r.git('reset', '-q', '--hard', 'HEAD^'); r.commit('a.txt', '3', 'local only')
  r.git('switch', '-q', 'main')
  await assert.rejects(planSwitch(r.run, { ...SWITCH, own: true, headSha: pushed }), /своя ветка feat разошлась с origin/)
  const plan = await planSwitch(r.run, { ...SWITCH, baseRef: 'gone', headSha: pushed })
  assert.equal(plan.baseFallback, true)
})

test('applySwitch: в дереве изменены отслеживаемые файлы — ошибка до переключения', async () => {
  const r = repo(); r.origin()
  r.commit('a.txt', '1', 'base'); r.git('push', '-q', 'origin', 'main')
  r.git('switch', '-qc', 'feat'); const head = r.commit('a.txt', '2', 'pr'); r.git('push', '-q', 'origin', 'feat'); r.git('switch', '-q', 'main')
  const plan = await planSwitch(r.run, { ...SWITCH, headSha: head })
  writeFileSync(join(r.dir, 'a.txt'), 'грязно')
  await assert.rejects(applySwitch(r.run, plan), /изменены отслеживаемые файлы/)
})

function ownRound() {
  const r = repo(); r.origin()
  r.commit('a.txt', '1', 'base'); r.git('push', '-q', 'origin', 'main')
  r.git('switch', '-qc', 'feat'); r.commit('a.txt', '2', 'pr'); r.git('push', '-q', '-u', 'origin', 'feat')
  return { r, roundBase: r.git('rev-parse', 'HEAD') }
}

test('messageProblem: одна непустая строка без пробелов по краям; кавычки и $ можно', () => {
  assert.equal(messageProblem('fix: "a" $b `c` \\d'), undefined)
  assert.match(messageProblem('a\nb') ?? '', /одна строка/)
  assert.match(messageProblem(' a') ?? '', /пробел/)
  assert.match(messageProblem('') ?? '', /пустое/)
})

test('раунд: commit → push; повтор после упавшего push только пушит; уже на origin — pushed', async () => {
  const { r, roundBase } = ownRound()
  writeFileSync(join(r.dir, 'a.txt'), '3')
  assert.equal((await roundState(r.run, { branch: 'feat', roundBase, message: 'fix: x' })).state, 'commit')
  assert.deepEqual(await foreignChanges(r.run, ['a.txt']), [])
  assert.deepEqual(await commitRound(r.run, { paths: ['a.txt'], message: 'fix: x' }), { ok: true })
  assert.equal((await roundState(r.run, { branch: 'feat', roundBase, message: 'fix: x' })).state, 'push')
  await assert.rejects(roundState(r.run, { branch: 'feat', roundBase, message: 'другое' }), /коммит раунда уже есть с сообщением «fix: x»/)
  assert.deepEqual(await pushRound(r.run, 'feat'), { ok: true })
  assert.equal((await roundState(r.run, { branch: 'feat', roundBase, message: 'fix: x' })).state, 'pushed')
})

test('раунд после влитой и запушенной базы: merge-коммит — не коммит раунда, база раунда — новый HEAD', async () => {
  const { r, roundBase } = ownRound()
  r.git('switch', '-qc', 'base', 'main'); r.commit('b.txt', '1', 'base work')
  r.git('switch', '-q', 'feat'); r.git('merge', '-q', '--no-ff', '-m', 'Merge base', 'base'); r.git('push', '-q', 'origin', 'feat')
  const merged = r.git('rev-parse', 'HEAD')
  assert.deepEqual(await roundState(r.run, { branch: 'feat', roundBase, message: 'fix: x' }), { state: 'commit', roundBase: merged })
})

test('headShift: тот же HEAD; влитая и запушенная база — законный сдвиг; не на origin или не потомок — сдвиг', async () => {
  const { r, roundBase } = ownRound()
  assert.equal(await headShift(r.run, { saved: roundBase, head: roundBase, branch: 'feat' }), 'same')
  const merged = r.commit('m.txt', '1', 'merge base')
  assert.equal(await headShift(r.run, { saved: roundBase, head: merged, branch: 'feat' }), 'moved')
  r.git('push', '-q', 'origin', 'feat')
  assert.equal(await headShift(r.run, { saved: roundBase, head: merged, branch: 'feat' }), 'pushed')
  r.git('switch', '-qc', 'other', 'main')
  const elsewhere = r.commit('o.txt', '1', 'other')
  assert.equal(await headShift(r.run, { saved: roundBase, head: elsewhere, branch: 'feat' }), 'moved')
})

test('файлы вне списка: сдвинутый сабмодуль не считается — как в снимке статуса скилла', async () => {
  const sub = repo(); sub.commit('s.txt', '1', 'sub 1')
  const { r } = ownRound()
  r.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.dir, 'sub'); r.git('commit', '-qm', 'add sub')
  sub.commit('s.txt', '2', 'sub 2')
  r.git('-C', 'sub', '-c', 'protocol.file.allow=always', 'pull', '-q', 'origin', 'main')
  writeFileSync(join(r.dir, 'a.txt'), '3')
  assert.deepEqual(await foreignChanges(r.run, ['a.txt']), [])
})

test('файлы вне списка и пустой раунд', async () => {
  const { r } = ownRound()
  writeFileSync(join(r.dir, 'a.txt'), '3'); writeFileSync(join(r.dir, 'b.txt'), 'new'); r.git('add', 'b.txt')
  assert.deepEqual(await foreignChanges(r.run, ['a.txt']), ['b.txt'])
  r.git('reset', '-q', 'b.txt')
  const empty = repo(); empty.commit('a.txt', '1', 'base')
  assert.deepEqual(await commitRound(empty.run, { paths: ['a.txt'], message: 'm' }), { ok: false, output: 'в подтверждённых путях нечего коммитить' })
  assert.deepEqual(await commitRound(empty.run, { paths: [], message: 'm' }), { ok: false, output: 'нет путей раунда — коммитить нечего' })
})

test('pre-commit упал — коммита нет, вывод хука возвращается', async () => {
  const { r, roundBase } = ownRound()
  writeFileSync(join(r.dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint: a.txt плохо"\nexit 1\n', { mode: 0o755 })
  writeFileSync(join(r.dir, 'a.txt'), '3')
  const result = await commitRound(r.run, { paths: ['a.txt'], message: 'fix: x' })
  assert.equal(result.ok, false)
  assert.match((result as { output: string }).output, /lint: a.txt плохо/)
  assert.equal(r.git('rev-parse', 'HEAD'), roundBase)
})

test('non-fast-forward отличается от сети; после rebase roundBase пересчитывается и раунд только пушится', async () => {
  const { r, roundBase } = ownRound()
  const other = repo(); other.git('remote', 'add', 'origin', r.git('remote', 'get-url', 'origin')); other.git('fetch', '-q', 'origin'); other.git('switch', '-q', 'feat')
  other.commit('c.txt', 'чужое', 'чужой коммит'); other.git('push', '-q', 'origin', 'feat')
  writeFileSync(join(r.dir, 'a.txt'), '3')
  await commitRound(r.run, { paths: ['a.txt'], message: 'fix: x' })
  const pushed = await pushRound(r.run, 'feat')
  assert.deepEqual([pushed.ok, (pushed as { rejected: boolean }).rejected], [false, true])
  r.git('pull', '-q', '--rebase', 'origin', 'feat')
  const state = await roundState(r.run, { branch: 'feat', roundBase, message: 'fix: x' })
  assert.equal(state.state, 'push')
  assert.notEqual(state.roundBase, roundBase)
})

test('push упал по сети (не non-ff) — повтор только пушит, второго коммита нет', async () => {
  const { r, roundBase } = ownRound()
  const url = r.git('remote', 'get-url', 'origin')
  writeFileSync(join(r.dir, 'a.txt'), '3')
  await commitRound(r.run, { paths: ['a.txt'], message: 'fix: x' })
  r.git('remote', 'set-url', 'origin', '/nonexistent/review-kit-origin')
  const failed = await pushRound(r.run, 'feat')
  assert.deepEqual([failed.ok, (failed as { rejected: boolean }).rejected], [false, false])
  r.git('remote', 'set-url', 'origin', url)
  assert.equal((await roundState(r.run, { branch: 'feat', roundBase, message: 'fix: x' })).state, 'push')
  assert.deepEqual(await pushRound(r.run, 'feat'), { ok: true })
  assert.equal(r.git('rev-list', '--count', `${roundBase}..HEAD`), '1')
})

test('уборка: ветка с непушнутыми коммитами не кандидат; review-stash находится и применяется', async () => {
  const { r } = ownRound()
  r.git('switch', '-q', 'main'); r.git('switch', '-qc', 'local-only'); r.commit('z.txt', 'z', 'не на origin'); r.git('switch', '-q', 'main')
  const candidates = await branchCandidates(r.run, { open: [], closed: [], me: 'alice' })
  assert.deepEqual(candidates.map(c => [c.name, c.kind]), [['feat', 'no-pr']])
  assert.deepEqual((await deleteBranches(r.run, ['local-only'])).skipped, [{ name: 'local-only', reason: 'есть коммиты, которых нет на origin' }])
  writeFileSync(join(r.dir, 'a.txt'), 'wip'); r.git('stash', 'push', '-q', '-m', 'review-kit: pr-7 test')
  const [stash] = await reviewStashes(r.run)
  assert.deepEqual([stash.message, stash.branch], ['review-kit: pr-7 test', 'main'])
  assert.deepEqual(await stashAction(r.run, stash.sha, 'apply'), { ok: true })
  assert.equal(r.git('stash', 'list'), '')
})

test('worktree ревью: PR меняет настройки Claude Code — worktree не создаётся', async () => {
  const r = repo(); r.origin()
  r.commit('a.txt', '1', 'base'); r.git('push', '-q', 'origin', 'main')
  r.git('switch', '-qc', 'feat/x'); r.commit('.claude/settings.json', '{}', 'hook'); const head = r.git('rev-parse', 'HEAD'); r.git('push', '-q', 'origin', 'feat/x'); r.git('switch', '-q', 'main')
  const input = { root: r.dir, number: 7, headRef: 'feat/x', headSha: head, baseRef: 'main', pullRef: 'refs/pull/7/head' }
  assert.equal(worktreeName(r.dir, 7, 'feat/x'), `${r.dir}/.claude/worktrees/pr-7-feat-x`)
  assert.equal(worktreeName('/r', 7, "x';curl e|sh;'$(id)"), '/r/.claude/worktrees/pr-7-x--curl-e-sh----id-')
  assert.equal(shellQuote("/a b/it's"), `'/a b/it'\\''s'`)
  const first = await createReviewWorktree(r.run, { ...input, isActive: async () => false })
  assert.deepEqual([first.created, first.risky], [false, ['.claude/settings.json']])
  assert.equal(existsSync(first.path), false)
})

test('worktree ревью: создаётся; повтор ставит на новую голову PR; грязный или с активным прогоном — ошибка; без базы — отказ', async () => {
  const r = repo(); const bare = r.origin()
  r.commit('a.txt', '1', 'base'); r.git('push', '-q', 'origin', 'main')
  r.git('switch', '-qc', 'feat'); const first = r.commit('a.txt', '2', 'pr'); r.git('push', '-q', 'origin', 'feat')
  const input = { root: r.dir, number: 8, headRef: 'feat', headSha: first, baseRef: 'main', pullRef: 'refs/pull/8/head', isActive: async () => false }
  const tree = await createReviewWorktree(r.run, input)
  assert.deepEqual([tree.created, r.git('-C', tree.path, 'rev-parse', 'HEAD')], [true, first])
  const next = r.commit('a.txt', '3', 'pr more'); r.git('push', '-q', 'origin', 'feat')
  const again = await createReviewWorktree(r.run, { ...input, headSha: next })
  assert.deepEqual([again.created, r.git('-C', tree.path, 'rev-parse', 'HEAD')], [false, next])
  await assert.rejects(createReviewWorktree(r.run, { ...input, headSha: next, isActive: async () => true }), /ревью PR 8 уже идёт/)
  writeFileSync(join(tree.path, 'a.txt'), 'грязно')
  await assert.rejects(createReviewWorktree(r.run, { ...input, headSha: next }), /в worktree .* есть изменения/)
  spawnSync('git', ['-C', bare, 'update-ref', '-d', 'refs/heads/main'])
  r.git('update-ref', '-d', 'refs/remotes/origin/main')
  await assert.rejects(createReviewWorktree(r.run, { ...input, number: 9, baseRef: 'gone', headSha: next }), /базу PR не найти/)
})
