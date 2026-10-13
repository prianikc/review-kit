import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyBash, guardText } from './policy.ts'

test('сырые git-команды и curl-запись распознаются, чтение — нет', () => {
  assert.equal(classifyBash('git commit -m x'), 'raw-commit')
  assert.equal(classifyBash('cd a && git push origin HEAD'), 'raw-push')
  assert.equal(classifyBash('git push --force'), 'raw-destructive')
  assert.equal(classifyBash('git commit --amend'), 'raw-destructive')
  assert.equal(classifyBash('git pull --rebase'), 'raw-destructive')
  assert.equal(classifyBash('git -c pull.rebase=true pull'), 'raw-destructive')
  assert.equal(classifyBash('git pull'), 'raw-destructive')
  assert.equal(classifyBash('git fetch origin'), 'other')
  assert.equal(classifyBash('git rebase main'), 'raw-destructive')
  assert.equal(classifyBash('curl -X POST https://x'), 'raw-write')
  assert.equal(classifyBash('git status && git log'), 'other')
  assert.equal(classifyBash("bash -c 'git push'"), 'raw-push')
})

test('guardText: что запрещено и чем пользоваться', () => {
  assert.match(guardText('raw-push') ?? '', /git push.*commit_push/)
  assert.equal(guardText('other'), undefined)
})
