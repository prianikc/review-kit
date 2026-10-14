import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createdHandle, previewHandles } from './orca.ts'

test('createdHandle: handle из ответа terminal create --json или ничего', () => {
  assert.equal(createdHandle('{"ok":true,"result":{"terminal":{"handle":"term_ab-1","title":"x"}}}'), 'term_ab-1')
  assert.equal(createdHandle('{"ok":false}'), undefined)
  assert.equal(createdHandle('не json'), undefined)
})

test('previewHandles: вкладки, в превью которых есть путь worktree, по одной на вкладку', () => {
  const list = JSON.stringify({ ok: true, result: { terminals: [
    { handle: 'term_1', tabId: 't1', preview: "cd '/r/.claude/worktrees/pr-7-feat' && claude" },
    { handle: 'term_2', tabId: 't1', preview: "/r/.claude/worktrees/pr-7-feat$ ls" },
    { handle: 'term_3', tabId: 't2', preview: "cd '/r/.claude/worktrees/pr-70-other'" },
    { handle: 'term_4', tabId: 't3', preview: 'prian@pc:~/r$' },
  ] } })
  assert.deepEqual(previewHandles(list, '/r/.claude/worktrees/pr-7-feat'), ['term_1'])
  assert.deepEqual(previewHandles('не json', '/r/x'), [])
})
