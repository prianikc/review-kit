import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recheckBase } from './git.ts'
import { repo } from './testing/repo.ts'

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
