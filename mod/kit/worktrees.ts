import type { EngineInterface } from 'claude-code'
import { ACTIONABLE, placeAll, pullRows } from '../status.ts'
import { createReviewWorktree, mainBranch, mainWorktree } from '../git.ts'
import { launchReview } from './background.ts'
import { RUN_FILES_EXCLUDE, WORKTREES_EXCLUDE, exclude, runner } from './engine.ts'
import { isActive } from './state.ts'
import { forge } from './forge.ts'

const HERE_SUFFIX = 'ревью в этой сессии'

export interface ReviewTree {
  pr: number
  path: string
  session: { id: string; name: string }
}

export interface HerePr {
  pr: number
  reason?: string
}

export async function mainRoot($: EngineInterface): Promise<string> {
  return mainWorktree(runner($))
}

export async function reviewWorktrees($: EngineInterface, prs?: number[]): Promise<{ trees: ReviewTree[]; here: HerePr[]; skipped: Array<{ pr: number; reason: string }> }> {
  const run = runner($)
  const provider = await forge($)
  const me = (await provider.currentUser()).toLowerCase()
  const rows = prs === undefined
    ? (await pullRows(provider)).rows.filter(row => ACTIONABLE.includes(row.scenario))
    : await Promise.all(prs.map(async number => {
      const pull = await provider.getPull(number)
      return { number, isOwn: pull.author.toLowerCase() === me, headRef: pull.headRef }
    }))
  const { trees: wanted, here: inMain } = placeAll(rows, { mainTreeBranch: await mainBranch(run) })
  const root = await mainRoot($)
  await exclude($, WORKTREES_EXCLUDE)
  await exclude($, RUN_FILES_EXCLUDE)
  const trees: ReviewTree[] = []
  const here: HerePr[] = inMain.map(pr => ({ pr }))
  const skipped: Array<{ pr: number; reason: string }> = []
  for (const number of wanted) {
    const pull = await provider.getPull(number)
    if (pull.state === 'closed') { skipped.push({ pr: number, reason: 'PR закрыт' }); continue }
    const tree = await createReviewWorktree(run, { root, number, headRef: pull.headRef, headSha: pull.headSha, baseRef: pull.baseRef, pullRef: provider.pullRef(number), isActive: isActive($) })
      .catch((error: Error) => ({ error: error.message }))
    if ('error' in tree) { skipped.push({ pr: number, reason: tree.error }); continue }
    const claudeFiles = [...tree.executable, ...tree.instructions]
    if (claudeFiles.length) { here.push({ pr: number, reason: `PR меняет файлы Claude Code (${claudeFiles.join(', ')}) — ${HERE_SUFFIX}` }); continue }
    const launched = await launchReview($, { pr: number, path: tree.path, prompt: prs === undefined ? `/pr ${number}` : `/pr ${number} review` })
    if ('error' in launched) { here.push({ pr: number, reason: `${launched.error} — ${HERE_SUFFIX}` }); continue }
    trees.push({ pr: number, path: tree.path, session: { id: launched.session.id, name: launched.session.name } })
  }
  return { trees, here, skipped }
}

export function backgroundText({ trees, here, skipped }: { trees: ReviewTree[]; here: HerePr[]; skipped: Array<{ pr: number; reason: string }> }): string {
  return [
    ...trees.map(tree => `Ревью PR ${tree.pr} запущено в фоне (сессия ${tree.session.name}) — кнопка ${tree.session.name} появится над промптом, когда ревью закончится.`),
    ...here.map(item => `PR ${item.pr}: ${item.reason ?? HERE_SUFFIX}. Запустите /pr ${item.pr}.`),
    ...skipped.map(item => `PR ${item.pr} пропущен: ${item.reason}.`),
  ].join('\n')
}

export async function backgroundReview($: EngineInterface, pr: number): Promise<string> {
  return backgroundText(await reviewWorktrees($, [pr]))
}

export async function reviewWorktreesAnswer($: EngineInterface, prs?: number[]): Promise<Awaited<ReturnType<typeof reviewWorktrees>> & { text: string }> {
  const result = await reviewWorktrees($, prs)
  return { ...result, text: backgroundText(result) }
}
