import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commitSource, guideText, parseTarget, prSource } from './guide.ts'
import { repo } from './testing/repo.ts'
import type { PullRequest } from './forge/types.ts'

const pull = (over: Partial<PullRequest> = {}): PullRequest => ({ number: 7, title: 'Экспорт', body: ' Экспорт в CSV ', author: 'bob', headRef: 'feature/x', headSha: 'h', baseRef: 'main', state: 'open', merged: false, url: 'https://git/pulls/7', conflicted: false, ...over })

test('parseTarget: число до 6 цифр (и #N) — PR, иначе коммит; мусор — ошибка', () => {
  assert.deepEqual(parseTarget('140'), { kind: 'pr', number: 140 })
  assert.deepEqual(parseTarget(' #140 '), { kind: 'pr', number: 140 })
  assert.deepEqual(parseTarget('3edsf3a'), { kind: 'commit', ref: '3edsf3a' })
  assert.deepEqual(parseTarget('1234567'), { kind: 'commit', ref: '1234567' })
  assert.deepEqual(parseTarget('HEAD~2'), { kind: 'commit', ref: 'HEAD~2' })
  assert.throws(() => parseTarget(''), /не номер PR и не коммит/)
  assert.throws(() => parseTarget('--all'), /не номер PR и не коммит/)
  assert.throws(() => parseTarget('a b'), /не номер PR и не коммит/)
})

test('prSource: заголовок, описание, пометки влитого и базы от main', () => {
  const source = prSource(pull({ merged: true, state: 'closed' }), { base: 'b', head: 'h', baseFallback: true })
  assert.equal(source.key, 'pr-7')
  assert.equal(source.heading, 'PR 7 · Экспорт · bob · main ← feature/x · влит')
  assert.equal(source.message, 'Экспорт в CSV')
  assert.equal(source.notes.length, 1)
  assert.deepEqual(prSource(pull({ body: undefined }), { base: 'b', head: 'h', baseFallback: false }).message, '')
})

test('prSource: перепроверка — дельта после моего ревью; полный режим — весь PR с пометкой', () => {
  const delta = prSource(pull(), { base: 'r', head: 'h', baseFallback: false, recheck: { mode: 'delta' } })
  assert.equal(delta.key, 'pr-7-delta')
  assert.match(delta.heading, / · изменения после моего ревью$/)
  assert.deepEqual(delta.notes, [])
  const full = prSource(pull(), { base: 'b', head: 'h', baseFallback: false, recheck: { mode: 'full', note: 'после rebase' } })
  assert.equal(full.key, 'pr-7')
  assert.deepEqual(full.notes, ['после rebase'])
})

test('commitSource + guideText: сообщение, stat и diff коммита от родителя', async () => {
  const r = repo()
  r.commit('a.txt', '1\n', 'base')
  const sha = r.commit('a.txt', '2\n', 'поменять a\n\nподробности')
  const source = await commitSource(r.run, sha.slice(0, 7))
  assert.equal(source.key, `commit-${sha.slice(0, 10)}`)
  assert.equal(source.message, 'поменять a\n\nподробности')
  const text = await guideText(r.run, source)
  assert.match(text, /^# Коммит /)
  assert.match(text, /## STAT\n```\n a\.txt \| 2 \+-/)
  assert.match(text, /-1\n\+2/)
  assert.doesNotMatch(text, /## COMMITS/)
})

test('commitSource: первый коммит — от пустого дерева; неизвестный — ошибка', async () => {
  const r = repo()
  const sha = r.commit('a.txt', 'x\n', 'init')
  const source = await commitSource(r.run, sha)
  assert.match(source.notes[0], /пустого дерева/)
  assert.match(await guideText(r.run, source), /\+x/)
  await assert.rejects(commitSource(r.run, 'deadbeef'), /коммит deadbeef не найден/)
})

test('guideText: список коммитов PR; большой diff не прикладывается', async () => {
  const r = repo()
  const base = r.commit('a.txt', '1\n', 'base')
  r.commit('a.txt', '2\n', 'первый')
  const head = r.commit('big.txt', `${'x'.repeat(70_000)}\n`, 'второй')
  const text = await guideText(r.run, prSource(pull(), { base, head, baseFallback: false }))
  assert.match(text, /## COMMITS\n\w+ первый\n\w+ второй/)
  assert.match(text, /## MESSAGE\n```\nЭкспорт в CSV\n```/)
  assert.match(text, /- big\.txt: diff не приложен — больше 60000 символов/)
  assert.doesNotMatch(text, /xxxxxxxxxx/)
})
