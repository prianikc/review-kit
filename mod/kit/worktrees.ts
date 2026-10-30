import type { EngineInterface } from 'claude-code'
import { ACTIONABLE, placeAll, pullRows } from '../status.ts'
import { createReviewWorktree, shellQuote, gitText, mainBranch } from '../git.ts'
import { WORKTREES_EXCLUDE, exclude, runner } from './engine.ts'
import { isActive } from './state.ts'
import { forge } from './forge.ts'

export interface ReviewTree {
  pr: number
  path: string
  command: string
  auto: boolean
  note?: string
}

export async function mainRoot($: EngineInterface): Promise<string> {
  return (await gitText(runner($), ['worktree', 'list', '--porcelain'])).split('\n')[0].slice('worktree '.length)
}

export async function reviewWorktrees($: EngineInterface, prs?: number[]): Promise<{ trees: ReviewTree[]; here: number[]; skipped: Array<{ pr: number; reason: string }> }> {
  const run = runner($)
  const provider = await forge($)
  const me = (await provider.currentUser()).toLowerCase()
  const rows = prs === undefined
    ? (await pullRows(provider)).rows.filter(row => ACTIONABLE.includes(row.scenario))
    : await Promise.all(prs.map(async number => {
      const pull = await provider.getPull(number)
      return { number, isOwn: pull.author.toLowerCase() === me, headRef: pull.headRef }
    }))
  const { trees: wanted, here } = placeAll(rows, { mainTreeBranch: await mainBranch(run) })
  const root = await mainRoot($)
  await exclude($, WORKTREES_EXCLUDE)
  const trees: ReviewTree[] = []
  const skipped: Array<{ pr: number; reason: string }> = []
  for (const number of wanted) {
    const pull = await provider.getPull(number)
    if (pull.state === 'closed') { skipped.push({ pr: number, reason: 'PR закрыт' }); continue }
    const tree = await createReviewWorktree(run, { root, number, headRef: pull.headRef, headSha: pull.headSha, baseRef: pull.baseRef, pullRef: provider.pullRef(number), isActive: isActive($) })
      .catch((error: Error) => ({ error: error.message }))
    if ('error' in tree) { skipped.push({ pr: number, reason: tree.error }); continue }
    if (tree.executable.length) { skipped.push({ pr: number, reason: `PR меняет настройки Claude Code (${tree.executable.join(', ')}) — новая сессия в его дереве запустила бы хуки и MCP из PR. Здесь: /pr ${number} — мод спросит перед переключением дерева` }); continue }
    const auto = tree.instructions.length === 0
    trees.push({
      pr: number,
      path: tree.path,
      command: `claude ${auto ? '--permission-mode auto ' : ''}${shellQuote(prs === undefined ? `/pr ${number}` : `/pr ${number} review`)}`,
      auto,
      ...(auto ? {} : { note: `без режима auto: PR меняет инструкции агенту (${tree.instructions.join(', ')}) — каждая команда спросит разрешение` }),
    })
  }
  return { trees, here, skipped }
}
