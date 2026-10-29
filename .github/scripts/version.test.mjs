import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bump, levelOf, manualBumpProblem, pluginChanged } from './version.mjs'

test('levelOf: major > minor > patch, посторонние метки не в счёт', () => {
  assert.equal(levelOf(['bug', 'minor', 'major']), 'major')
  assert.equal(levelOf(['minor']), 'minor')
  assert.equal(levelOf(['documentation']), 'patch')
  assert.equal(levelOf([]), 'patch')
})

test('bump: patch / minor / major обнуляют младшие; не semver — ошибка', () => {
  assert.equal(bump('7.0.2', 'patch'), '7.0.3')
  assert.equal(bump('7.0.2', 'minor'), '7.1.0')
  assert.equal(bump('7.9.9', 'major'), '8.0.0')
  assert.throws(() => bump('abc', 'patch'), /не semver/)
})

test('pluginChanged: файлы плагина — да; документы и .github — нет', () => {
  assert.equal(pluginChanged(['mod/git.ts', 'README.md']), true)
  assert.equal(pluginChanged(['README.md', 'docs/a.md', '.github/workflows/ci.yml']), false)
})

test('manualBumpProblem: версия в PR не меняется', () => {
  assert.equal(manualBumpProblem({ before: '7.0.2', after: '7.0.2' }), null)
  assert.match(manualBumpProblem({ before: '7.0.2', after: '7.1.0' }), /version поднимает GitHub Actions при слиянии/)
})
