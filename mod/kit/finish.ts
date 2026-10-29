import type { EngineInterface } from 'claude-code'
import { deleteBranches, gitText, inMainTree, removeWorktrees, stashAction, STASH_GONE, switchBack, type Run } from '../git.ts'
import { projectRoot, runner, readJson } from './engine.ts'
import { activeRun, runFacts, runDir, READ_ONLY_SCENARIOS, finishRun, isActive } from './state.ts'
import { mainRoot } from './tabs.ts'

export interface RunReturn {
  headRef?: string
  returnTo?: string
  stash?: string | null
  stashSha?: string | null
}

export async function dropReviewWorktree($: EngineInterface): Promise<string | undefined> {
  const run = runner($)
  if (await inMainTree(run)) return undefined
  const here = await projectRoot($)
  const main = await mainRoot($)
  const fromMain: Run = (argv, init) => run(argv, { cwd: main, ...init })
  const result = await removeWorktrees(fromMain, [here], { confirmed: false, isActive: isActive($) })
  if (result.removed.length) return `worktree ${here} удалён — ревью закончено, вкладку можно закрыть; команды в ней больше не работают`
  const reason = result.skipped[0]?.reason
  return reason && reason !== 'не worktree ревью' ? `worktree ${here} оставлен (${reason}) — уберётся при следующем /pr` : undefined
}

export async function restoreTree($: EngineInterface, { headRef, returnTo, stash, stashSha }: RunReturn): Promise<string | undefined> {
  const run = runner($)
  if (!(await inMainTree(run))) return undefined
  const current = (await gitText(run, ['branch', '--show-current'])).trim()
  if (current !== '' && current !== headRef) return undefined
  const back = await switchBack(run, returnTo === headRef ? undefined : returnTo)
  if (back.problem) return `дерево оставлено на ${current || 'коммите PR'} (${back.problem})${stash ? ` — ваши изменения в stash «${stash}»` : ''}`
  const removed = current && current !== back.on ? await deleteBranches(run, [current]) : { deleted: [], skipped: [] }
  const branch = removed.deleted.length ? `, ветка ${current} удалена` : removed.skipped.length ? `, ветка ${current} оставлена (${removed.skipped[0].reason})` : ''
  const applied = stashSha ? await stashAction(run, stashSha, 'apply') : undefined
  const restored = !applied ? '' : applied.ok ? ', изменения из stash возвращены' : applied.error === STASH_GONE ? '' : `; stash «${stash}» ${applied.error}`
  return `дерево на ${back.on}${branch}${restored}`
}

export async function finishReview($: EngineInterface, pr: number): Promise<string> {
  if ((await activeRun($)) !== pr) return `not finished: нет активного прогона PR ${pr}`
  const scenario = (await runFacts($))?.scenario
  const saved = await readJson<RunReturn>($, `${await runDir($, pr)}/context.json`, {})
  await finishRun($, pr, 'done')
  await dropGuides($, pr).catch(() => undefined)
  if (!scenario || !READ_ONLY_SCENARIOS.includes(scenario)) {
    const kept = saved.stash ? `\nизменения с ветки ${saved.returnTo ?? '—'} — в stash «${saved.stash}»: вернуться на ветку и git stash pop` : ''
    return `finished${kept}`
  }
  const dropped = await dropReviewWorktree($).catch(error => `worktree не удалён: ${(error as Error).message} — уберётся при следующем /pr`)
    ?? await restoreTree($, saved).catch(error => `дерево не возвращено: ${(error as Error).message}${saved.stash ? ` — ваши изменения в stash «${saved.stash}»` : ''}`)
  return dropped ? `finished\n${dropped}` : 'finished'
}

export async function dropGuides($: EngineInterface, pr: number): Promise<void> {
  const dir = `${await projectRoot($)}/.review-kit/guide`
  await runner($)(['rm', '-f', `${dir}/pr-${pr}.md`, `${dir}/pr-${pr}-delta.md`])
}
