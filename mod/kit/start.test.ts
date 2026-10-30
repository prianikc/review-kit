import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePrArgs } from './start.ts'

test('parsePrArgs: список, PR, PR со сценарием, stop; остальное — ошибка', () => {
  assert.deepEqual(parsePrArgs(''), {})
  assert.deepEqual(parsePrArgs('stop'), { stop: true })
  assert.deepEqual(parsePrArgs('7'), { pr: 7 })
  assert.deepEqual(parsePrArgs(' 7  fix '), { pr: 7, scenario: 'fix' })
  assert.deepEqual(parsePrArgs('7 review'), { pr: 7, scenario: 'review' })
  assert.deepEqual(parsePrArgs('7 feedback'), { pr: 7, scenario: 'feedback' })
  assert.ok('error' in parsePrArgs('7 blah'))
  assert.ok('error' in parsePrArgs('0'))
  assert.ok('error' in parsePrArgs('all'))
  assert.ok('error' in parsePrArgs('stop 7'))
  assert.ok('error' in parsePrArgs('7 fix x'))
  assert.ok('error' in parsePrArgs('0x7'))
  assert.ok('error' in parsePrArgs('1e1'))
})
