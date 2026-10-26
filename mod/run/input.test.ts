import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildInput, fenced, fileStates, inputLimit, itemsSection, lineCount, manifestText, MAX_INPUT_CHARS, notAttached } from './input.ts'
import { repo } from '../testing/repo.ts'

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

test('buildInput: разделы RULES/DIFF/FILES и ITEMS; лимит входа', async () => {
  const r = repo()
  const base = r.commit('a.ts', '1\n', 'base')
  const head = r.commit('a.ts', '2\n', 'head')
  const text = await buildInput(r.run, { base, head, rules: new Map([['CLAUDE.md', 'правило']]), items: [{ id: 'i1', path: 'a.ts', position: 1, author: 'carol', quote: 'почему 2?', stale: true }] })
  assert.match(text, /^## RULES\nRule files apply to this PR\. Read each whole from your manifest — the copy is `rules\/<path>` next to this input; cite it by <path>\.\n=== RULE FILE: CLAUDE.md ===\n\n## DIFF/)
  assert.doesNotMatch(text, /правило/)
  assert.match(await buildInput(r.run, { base, head, rules: new Map() }), /^## RULES\nNo rule files apply to this PR\.\n/)
  assert.match(text, /## DIFF\n```diff\n[\s\S]*\+2/)
  assert.match(text, /## FILES\n=== FILE: a.ts ===\n```\n2\n\n```/)
  assert.match(text, /## ITEMS\n### i1 — a.ts:1 — carol \(stale\)\nпочему 2\?/)
  assert.ok((await buildInput(r.run, { base, head, rules: new Map([['CLAUDE.md', 'x'.repeat(MAX_INPUT_CHARS)]]) })).length < 1000)
})

test('buildInput: DISCUSSION — между RULES и DIFF', async () => {
  const r = repo()
  const base = r.commit('a.ts', '1\n', 'base')
  const head = r.commit('a.ts', '2\n', 'head')
  const text = await buildInput(r.run, { base, head, rules: new Map(), discussion: '## DISCUSSION\nобсуждения нет' })
  assert.match(text, /No rule files apply to this PR\.\n\n## DISCUSSION\nобсуждения нет\n\n## DIFF/)
})

test('inputLimit: opus — 500 000, остальные и без модели — 250 000', () => {
  assert.equal(inputLimit('opus'), 500_000)
  assert.equal(inputLimit('sonnet'), MAX_INPUT_CHARS)
  assert.equal(inputLimit('haiku'), 250_000)
  assert.equal(inputLimit(), 250_000)
})

test('buildInput: лимит по модели — 300 000 проходит на opus, на sonnet отказ с подсказкой', async () => {
  const r = repo()
  const base = r.commit('a.ts', '1\n', 'base')
  for (const name of ['b.ts', 'c.ts', 'd.ts']) r.commit(name, `${'y'.repeat(59_000)}\n`, name)
  const head = r.git('rev-parse', 'HEAD')
  const rules = new Map<string, string>()
  assert.ok((await buildInput(r.run, { base, head, rules, model: 'opus' })).length > 300_000)
  await assert.rejects(buildInput(r.run, { base, head, rules, model: 'sonnet' }), /больше лимита 250000 для модели sonnet \(у opus — 500000\): в дельте 3 файл\(ов\)/)
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

test('itemsSection: ответы автора — метка answered и текст после цитаты', () => {
  assert.equal(
    itemsSection([{ id: 'r2/c5', path: 'a.ts', line: 3, author: 'alice', quote: 'тут null', replies: [{ author: 'bob', body: 'проверка выше' }] }]),
    '## ITEMS\n### r2/c5 — a.ts:3 — alice (answered)\nтут null\n\nОтвет bob:\nпроверка выше',
  )
  assert.equal(itemsSection([{ id: 'r2/c6', path: 'a.ts', line: 4, author: 'alice', quote: 'имя', replies: [] }]), '## ITEMS\n### r2/c6 — a.ts:4 — alice\nимя')
})

test('manifestText: пути и заметки', () => {
  assert.equal(manifestText(['/r/CLAUDE.md'], ['нет правил']), '/r/CLAUDE.md\n# нет правил\n')
})
