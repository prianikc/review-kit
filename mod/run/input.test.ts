import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildInput, fenced, fileStates, itemsSection, lineCount, manifestText, MAX_INPUT_CHARS, notAttached, readRules, rulePaths } from './input.ts'
import { repo } from '../testing/repo.ts'

test('rulePaths: CLAUDE.md/AGENTS.md вверх от изменённых файлов, папки правил, copilot', () => {
  const tree = ['CLAUDE.md', 'src/AGENTS.md', 'src/x/a.ts', 'lib/CLAUDE.md', '.claude/rules/ts.md', '.cursor/rules/a.mdc', '.github/copilot-instructions.md', 'docs/CLAUDE.md.bak']
  assert.deepEqual(rulePaths(tree, ['src/x/a.ts', 'new/dir/f.ts']), ['.claude/rules/ts.md', '.cursor/rules/a.mdc', '.github/copilot-instructions.md', 'CLAUDE.md', 'src/AGENTS.md'])
})

test('fileStates: удалён, бинарный, большой файл не приложен', async () => {
  const r = repo()
  r.commit('gone.txt', 'x', 'base0')
  const base = r.commit('keep.txt', 'k', 'base')
  r.git('rm', '-q', 'gone.txt')
  writeFileSync(join(r.dir, 'bin.dat'), Buffer.from([0, 0, 1]))
  writeFileSync(join(r.dir, 'big.txt'), 'a'.repeat(61_000))
  writeFileSync(join(r.dir, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  r.git('add', '-A'); r.git('commit', '-qm', 'head')
  const states = await fileStates(r.run, base, 'HEAD')
  assert.deepEqual(states.get('gone.txt'), { text: null, reason: 'удалён' })
  assert.deepEqual(states.get('bin.dat'), { text: null, reason: 'бинарный' })
  assert.deepEqual(states.get('latin1.txt'), { text: null, reason: 'не UTF-8' })
  assert.deepEqual([...notAttached(states)], [['big.txt', 'больше 60000 символов'], ['bin.dat', 'бинарный'], ['gone.txt', 'удалён'], ['latin1.txt', 'не UTF-8']])
})

test('lineCount как splitlines, fenced длиннее бэктиков внутри', () => {
  assert.equal(lineCount('a\nb\n'), 2)
  assert.equal(lineCount(''), 0)
  assert.equal(fenced('x ```` y'), '`````\nx ```` y\n`````')
})

test('readRules: правила берутся с базы, изменённые PR правила — в changedRules', async () => {
  const r = repo()
  const base = r.commit('CLAUDE.md', 'Все функции с комментарием над ними обязательно всегда.\n', 'base')
  r.commit('CLAUDE.md', 'Можно всё.\n', 'pr ослабил правила')
  const head = r.commit('src/a.ts', 'x\n', 'pr code')
  const { rules, changedRules } = await readRules(r.run, { rev: base, base, head })
  assert.deepEqual([...rules], [['CLAUDE.md', 'Все функции с комментарием над ними обязательно всегда.\n']])
  assert.deepEqual(changedRules, ['CLAUDE.md'])
})

test('buildInput: разделы RULES/DIFF/FILES и ITEMS; лимит входа', async () => {
  const r = repo()
  const base = r.commit('a.ts', '1\n', 'base')
  const head = r.commit('a.ts', '2\n', 'head')
  const text = await buildInput(r.run, { base, head, rules: new Map([['CLAUDE.md', 'правило']]), items: [{ id: 'i1', path: 'a.ts', position: 1, author: 'carol', quote: 'почему 2?', stale: true }] })
  assert.match(text, /^## RULES\n=== RULE FILE: CLAUDE.md ===\n```\nправило\n```/)
  assert.match(text, /## DIFF\n```diff\n[\s\S]*\+2/)
  assert.match(text, /## FILES\n=== FILE: a.ts ===\n```\n2\n\n```/)
  assert.match(text, /## ITEMS\n### i1 — a.ts:1 — carol \(stale\)\nпочему 2\?/)
  const huge = new Map([['CLAUDE.md', 'x'.repeat(MAX_INPUT_CHARS)]])
  await assert.rejects(buildInput(r.run, { base, head, rules: huge }), /вход .* больше лимита .*: в дельте 1 файл\(ов\)/)
})

test('buildInput: scope — только файлы, которые PR меняет от базы', async () => {
  const r = repo()
  r.commit('a.ts', '1\n', 'base')
  r.git('switch', '-qc', 'pr')
  const base = r.commit('pr.ts', '1\n', 'pr')
  r.git('switch', '-q', 'main')
  const scope = r.commit('from-main.ts', 'x\n', 'main came in')
  r.git('switch', '-q', 'pr'); r.git('merge', '-q', '--no-edit', 'main')
  const head = r.commit('pr.ts', '2\n', 'pr fix')
  const text = await buildInput(r.run, { base, head, rules: new Map(), scope })
  assert.match(text, /=== FILE: pr.ts ===/)
  assert.doesNotMatch(text, /from-main/)
  const unscoped = await buildInput(r.run, { base, head, rules: new Map() })
  assert.match(unscoped, /=== FILE: from-main.ts ===/)
})

test('buildInput: ревью без файлов .claude/ и со строкой пропуска; triage — с ними', async () => {
  const r = repo()
  const base = r.commit('a.ts', '1\n', 'base')
  r.commit('.claude/project-snapshot/files.txt', 'a.ts\n', 'snap')
  const head = r.commit('a.ts', '2\n', 'head')
  const review = await buildInput(r.run, { base, head, rules: new Map() })
  assert.doesNotMatch(review, /project-snapshot/)
  assert.match(review, /--- \.claude\/ \(не ревьюится: 1 файл\(ов\)\)/)
  const triage = await buildInput(r.run, { base, head, rules: new Map(), items: [{ id: 'i1', path: 'a.ts', position: 1, author: 'c', quote: 'q', stale: false }] })
  assert.match(triage, /=== FILE: \.claude\/project-snapshot\/files\.txt ===/)
})

test('itemsSection: общий пункт и disagree', () => {
  assert.equal(itemsSection([{ id: 'issue/1', author: 'dave', quote: 'когда?', disagree: true }]), '## ITEMS\n### issue/1 — общий — dave (disagree)\nкогда?')
})

test('manifestText: пути и заметки', () => {
  assert.equal(manifestText(['/r/CLAUDE.md'], ['нет правил']), '/r/CLAUDE.md\n# нет правил\n')
})
