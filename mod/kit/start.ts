import type { EngineInterface } from 'claude-code'
import { contextOf, prListText, pullRows, intakeItems, loadPr, scenarioOf, type PrContext } from '../status.ts'
import { applySwitch, changedFiles, claudeCodeChanges, deleteBranches, isAncestor, mergeBase, operationInProgress, unmergedPaths, gitText, headShift, holder as worktreeHolder, inMainTree, planSwitch, leftoverRuns, removeWorktrees, stashAction, unpushed, worktreeCandidates, type SwitchPlan } from '../git.ts'
import { overviewText } from '../run/overview.ts'
import { STATUS_ARGV, SUBMIT_ATTEMPTS, CANCEL, CLEAR, CONTINUE_THERE, CONTINUE_HEAD, projectRoot, submitLater, runner, readJson, type Handoff, type Loaded } from './engine.ts'
import { ABANDONED_AFTER_MIN, activeRun, runFacts, runDir, openRun, deleteRunDir, foreignRun, type RunScenario, SKILL_OF, handOff, parseSaved, finishRun, isActive, isLive, writeContext } from './state.ts'
import { roadmapDir, forge } from './forge.ts'

export const USAGE = 'Использование: /pr [номер PR [review|feedback|fix]] | /pr stop'

export const PR_SCENARIOS = ['review', 'feedback', 'fix'] as const

export const SCENARIO_TEXT = {
  'none-own': 'Новых замечаний к вашему PR нет — ждём ревью. Ответить на прежние или поправить ещё — /pr <номер> feedback, /pr <номер> fix.',
  'wait-author': 'Ждём автора: после вашего ревью нет ни новых коммитов, ни ответов в ваших тредах.',
} as const

export async function resumeRun($: EngineInterface, pr: number, handoff: Handoff): Promise<string | typeof CLEAR> {
  const dir = await runDir($, pr)
  const text = await $.fs.read(`${dir}/context.json`).then(String, () => '')
  const saved = parseSaved(text)
  if (!saved?.head) return `Прогон PR ${pr} повреждён — выберите «Очистить».`
  if (saved.scenario === 'recheck') return `Прогон PR ${pr} из прежней версии (перепроверка) — /pr stop, затем /pr ${pr}.`
  const head = (await runner($)(['git', 'rev-parse', 'HEAD'])).stdout.trim()
  const shift = await headShift(runner($), { saved: saved.head, head, branch: saved.headRef ?? '' })
  if (shift === 'moved') {
    const question = `Дерево сдвинуто после прерванного прогона PR ${pr}: ${head.slice(0, 7)} вместо ${saved.head.slice(0, 7)}, и этого коммита нет на origin.`
    const answer = await $.ui.ask(question, [CONTINUE_HEAD, CLEAR, CANCEL]).catch(() => CANCEL)
    if (answer === CLEAR) return CLEAR
    if (answer !== CONTINUE_HEAD) return 'Отменено: дерево не тронуто.'
  }
  if (shift !== 'same') await $.fs.write(`${dir}/context.json`, JSON.stringify({ ...JSON.parse(text), head }))

  const fresh = (await prContext($, pr)).context
  const scenario = (saved.scenario && saved.scenario in SKILL_OF ? saved.scenario : 'review') as RunScenario
  await openRun($, { pr, context: fresh, head, scenario })
  const moved = shift === 'same' ? '' : ` Прогон идёт с текущего HEAD ${head.slice(0, 7)}.`
  return `Прогон PR ${pr} продолжен в этой сессии.${moved}${handOff($, pr, handoff, scenario)}`
}

export interface SavedStash {
  name: string
  sha: string
}

export async function stashTop($: EngineInterface): Promise<string> {
  return (await runner($)(['git', 'rev-parse', '-q', '--verify', 'refs/stash'])).stdout.trim()
}

export async function stashChanges($: EngineInterface, pr: number): Promise<SavedStash> {
  const now = (await runner($)(['date', '+%Y-%m-%d %H:%M:%S'])).stdout.trim()
  const name = `review-kit: pr-${pr} ${now}`
  const before = await stashTop($)
  await gitText(runner($), ['stash', 'push', '-m', name])
  const sha = await stashTop($)
  if (!sha || sha === before) throw new Error('stash не создан — дерево не тронуто')
  return { name, sha }
}

export async function switchOrRestore($: EngineInterface, { plan, stash }: { plan: SwitchPlan; stash: SavedStash | null }): Promise<{ head: string; base: string; detached: boolean; baseFallback: boolean; baseNote?: string }> {
  const run = runner($)
  const before = (await gitText(run, ['rev-parse', 'HEAD'])).trim()
  try {
    return await applySwitch(run, plan)
  } catch (error) {
    if (!stash) throw error
    const after = (await gitText(run, ['rev-parse', 'HEAD'])).trim()
    if (after !== before) throw new Error(`${(error as Error).message}; дерево уже на коммите PR; stash «${stash.name}» не применён — вернитесь (git switch -) и примените: git stash pop`)
    const restored = await stashAction(run, stash.sha, 'apply')
    const note = restored.ok ? 'изменения возвращены из stash' : restored.conflict ? `изменения из stash «${stash.name}» ${restored.error}` : `изменения остались в stash «${stash.name}»: ${restored.error}`
    throw new Error(`${(error as Error).message}; ${note}`)
  }
}

export async function prContext($: EngineInterface, pr: number): Promise<Loaded> {
  const data = await loadPr(await forge($), pr)
  return { context: contextOf(data, scenarioOf(data)), data }
}

export async function releaseWorktree($: EngineInterface, { pr, headRef }: { pr: number; headRef: string }): Promise<string | undefined> {
  const held = await worktreeHolder(runner($), headRef, isActive($))
  if (!held) return undefined
  const finished = !held.active && !held.dirty
  if (finished) {
    const result = await removeWorktrees(runner($), [held.path], { confirmed: false, isActive: isActive($) })
    if (result.removed.length) return undefined
  }

  const changes = held.dirty ? ' В нём есть незакоммиченные изменения — они удалятся.' : ''
  const question = held.active
    ? `Ветка ${headRef} занята: ревью PR ${held.pr} ещё идёт в ${held.path}.${changes} После очистки закройте ту вкладку.`
    : `Ветка ${headRef} занята worktree законченного ревью ${held.path}.${changes}`
  const answer = await $.ui.ask(question, held.active ? [CONTINUE_THERE, CLEAR, CANCEL] : [CLEAR, CANCEL]).catch(() => CANCEL)

  if (answer === CONTINUE_THERE) return `Ревью PR ${held.pr} продолжается в своей вкладке. Если она закрыта: cd '${held.path}' && claude --permission-mode auto "/pr ${held.pr}". Дерево здесь не тронуто.`
  if (answer !== CLEAR) return 'Отменено: дерево не тронуто.'

  const result = await removeWorktrees(runner($), [held.path], { confirmed: true, isActive: isActive($) })
  return result.removed.length ? undefined : `review-kit: worktree ${held.path} не удалён — ${result.skipped[0]?.reason ?? 'причина неизвестна'}. PR ${pr} не начат.`
}

export async function dropFinishedWorktrees($: EngineInterface): Promise<number> {
  const run = runner($)
  const provider = await forge($)
  const [open, me] = await Promise.all([provider.listPulls('open'), provider.currentUser()])
  const trees = await worktreeCandidates(run, { open, me, isActive: isLive($) })
  if (trees.length === 0) return 0
  const result = await removeWorktrees(run, trees.map(tree => tree.path), { confirmed: false, isActive: isLive($) })
  const branches = trees.filter(tree => tree.deleteBranch && result.removed.includes(tree.path)).map(tree => tree.branch)
  if (branches.length) await deleteBranches(run, branches)
  return result.removed.length
}

export async function selfClean($: EngineInterface): Promise<string> {
  try {
    const run = runner($)
    if (!(await inMainTree(run)) || (await activeRun($)) !== undefined) return ''
    const root = await projectRoot($)
    const live = isLive($)
    const names = (await run(['ls', '-1', `${root}/.review-kit/run`])).stdout.split('\n').filter(Boolean)
    const numbers = names.filter(name => /^\d+$/.test(name)).map(Number)
    const active = new Set((await Promise.all(numbers.map(async pr => ((await live(root, pr)) ? pr : null)))).filter((pr): pr is number => pr !== null))
    const runs = leftoverRuns(names, { active })
    for (const pr of runs) await deleteRunDir($, pr)
    const guides = (await run(['find', `${root}/.review-kit/guide`, '-name', '*.md', '-mmin', `+${ABANDONED_AFTER_MIN}`, '-print', '-delete'])).stdout.split('\n').filter(Boolean).length
    const trees = await dropFinishedWorktrees($).catch(() => 0)
    const parts = [runs.length ? `папок прогонов ${runs.length}` : '', guides ? `гайдов ${guides}` : '', trees ? `worktree ревью ${trees}` : ''].filter(Boolean)
    return parts.length ? `Убрано за прошлыми прогонами: ${parts.join(', ')}.` : ''
  } catch {
    return ''
  }
}

export function closedText(context: PrContext): string {
  return context.merged ? `PR ${context.number} влит — сценариев нет. Отчёт по нему: /pr ${context.number} review` : `PR ${context.number} закрыт без слияния — сценариев нет.`
}

export async function askAboutActive($: EngineInterface, pr: number | undefined, handoff: Handoff): Promise<string | undefined> {
  const active = await activeRun($)
  if (active === undefined) return undefined

  if (active === pr) return `Продолжаем PR ${pr}.${handOff($, pr, handoff, (await runFacts($))?.scenario)}`

  const question = `Идёт прогон PR ${active}. Начать PR ${pr}?`
  const answer = await $.ui.ask(question, [`Вернуться к PR ${active}`, `Прервать PR ${active}`]).catch(() => undefined)
  if (answer !== `Прервать PR ${active}`) return `Продолжаем PR ${active}.`
  await finishRun($, active, 'aborted')
  return undefined
}

export type PrScenario = (typeof PR_SCENARIOS)[number]

export function parsePrArgs(arg: string): { stop: true } | { pr?: number; scenario?: PrScenario } | { error: string } {
  const words = arg.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return {}
  if (words.length === 1 && words[0] === 'stop') return { stop: true }
  const pr = /^\d+$/.test(words[0]) ? Number(words[0]) : NaN
  const scenario = PR_SCENARIOS.find(name => name === words[1])
  if (!Number.isInteger(pr) || pr < 1 || words.length > 2 || (words.length === 2 && !scenario)) return { error: USAGE }
  return scenario ? { pr, scenario } : { pr }
}

export async function routePr($: EngineInterface, pr: number | undefined, handoff: Handoff, scenario?: PrScenario): Promise<string> {
  const cleaned = await selfClean($)
  const text = await routeOnce($, pr, handoff, scenario)
  return cleaned ? `${text}\n${cleaned}` : text
}

export async function routeOnce($: EngineInterface, pr: number | undefined, handoff: Handoff, scenario?: PrScenario): Promise<string> {
  if (pr === undefined) {
    const { rows, truncated } = await pullRows(await forge($))
    const active = await activeRun($)
    return `${prListText(rows, truncated)}${active === undefined ? '' : `\n\nИдёт прогон PR ${active} — продолжить: /pr ${active}`}`
  }

  const loaded = await prContext($, pr)
  const { context } = loaded
  if (scenario === 'review') return startReview($, pr, { loaded, handoff })
  if (scenario === 'fix') return startFix($, pr, { loaded, handoff, scenario: 'fix' })
  if (scenario === 'feedback') {
    if (context.isOwn && intakeItems(loaded.data).length === 0) return `У PR ${pr} нет замечаний. Правки: /pr ${pr} fix`
    return startFix($, pr, { loaded, handoff, scenario: 'feedback' })
  }
  if (context.scenario === 'review') return startReview($, pr, { loaded, handoff })
  if (context.scenario === 'feedback') return startFix($, pr, { loaded, handoff, scenario: 'feedback' })
  if (context.scenario === 'recheck') return startReview($, pr, { loaded, handoff })
  if (context.scenario === 'conflict') return conflictHandoff($, context, handoff)
  return context.scenario === 'closed' ? closedText(context) : SCENARIO_TEXT[context.scenario]
}

export function conflictHandoff($: EngineInterface, context: PrContext, handoff: Handoff): string {
  const text = `Use the review-kit:pr-confl skill for PR ${context.number}`
  const what = `PR ${context.number} (свой): конфликт с ${context.baseRef}.`
  if (handoff === 'return') return `${what} ${text}`
  submitLater($, text, SUBMIT_ATTEMPTS)
  return `${what} Разрешаю: /pr-confl ${context.number}.`
}

export async function startReview($: EngineInterface, pr: number, { loaded, handoff }: { loaded: Loaded; handoff: Handoff }): Promise<string> {
  const { context } = loaded
  if (context.state === 'closed' && !context.merged) return `PR ${pr} закрыт без слияния — ревью не делаю.`
  return startRun($, pr, { loaded, handoff, scenario: 'review' })
}

export async function startFix($: EngineInterface, pr: number, { loaded, handoff, scenario }: { loaded: Loaded; handoff: Handoff; scenario: 'feedback' | 'fix' }): Promise<string> {
  const { context } = loaded
  if (!context.isOwn) return `PR ${pr} не ваш: замечания и правки — только свой PR. Ревью чужого — /pr ${pr}.`
  if (context.state === 'closed') return `PR ${pr} закрыт — правок нет.`
  return startRun($, pr, { loaded, handoff, scenario })
}

export async function startRun($: EngineInterface, pr: number, { loaded, handoff, scenario }: { loaded: Loaded; handoff: Handoff; scenario: RunScenario }): Promise<string> {
  const { context } = loaded
  const stop = await askAboutActive($, pr, handoff)
  if (stop) return stop

  if (await foreignRun($, pr)) {
    const question = `Прогон PR ${pr} открыт в другой сессии. Если та вкладка ещё открыта — сначала закройте прогон там.`
    const answer = await $.ui.ask(question, ['Продолжить здесь', CLEAR, CANCEL]).catch(() => undefined)
    if (answer === 'Продолжить здесь') {
      const resumed = await resumeRun($, pr, handoff)
      if (resumed !== CLEAR) return resumed
    } else if (answer !== CLEAR) return 'Отменено: дерево не тронуто.'
  }

  const held = await releaseWorktree($, { pr, headRef: context.headRef })
  if (held) return held

  const root = await projectRoot($)

  const run = runner($)
  const provider = await forge($)
  const plan = await planSwitch(run, { number: pr, headRef: context.headRef, headSha: context.headSha, baseRef: context.baseRef, own: context.isOwn, pullRef: provider.pullRef(pr) })
  if (!context.isOwn) {
    const { executable, instructions } = claudeCodeChanges(await changedFiles(run, plan.base, plan.target))
    if (executable.length || instructions.length) {
      const what = [
        ...(executable.length ? [`Настройки, хуки, MCP — могут выполнить команды на вашей машине, когда дерево переключится на PR:\n${executable.join('\n')}`] : []),
        ...(instructions.length ? [`Инструкции агенту — следующие сессии в этом дереве их прочитают:\n${instructions.join('\n')}`] : []),
      ]
      const answer = await $.ui.ask(`PR ${pr} меняет файлы Claude Code.\n${what.join('\n')}`, ['Отмена', 'Продолжить']).catch(() => 'Отмена')
      if (answer !== 'Продолжить') return 'Отменено: дерево не тронуто.'
    }
  }

  const dirty = (await runner($)(STATUS_ARGV)).stdout.trim()
  const saved = dirty ? await stashChanges($, pr) : null
  const stash = saved?.name ?? null

  const returnTo = (await gitText(run, ['branch', '--show-current'])).trim() || (await gitText(run, ['rev-parse', 'HEAD'])).trim()
  const switched = await switchOrRestore($, { plan, stash: saved })
  await deleteRunDir($, pr)
  const dir = `${root}/.review-kit/run/${pr}`
  if (scenario === 'feedback' || scenario === 'fix') {
    const items = intakeItems(loaded.data)
    await $.fs.write(`${dir}/intake.json`, JSON.stringify({ head: context.headSha, items }, null, 2))
    await $.fs.write(`${dir}/overview.md`, overviewText(loaded.data, items))
  }
  const roadmap = context.isOwn ? { roadmap: `${await roadmapDir($)}/pr-${pr}-review-fixes.md` } : {}
  await $.fs.write(`${dir}/context.json`, JSON.stringify({ ...context, ...switched, stash, stashSha: saved?.sha ?? null, returnTo, scenario, ...roadmap }))
  await openRun($, { pr, context, head: switched.head, scenario })
  if (scenario === 'conflict') return `PR ${pr} (свой, конфликт): дерево на ${context.headRef}${stash ? `, stash «${stash}»` : ''}.`
  const next = handOff($, pr, handoff, scenario)

  if (scenario === 'feedback' || scenario === 'fix') {
    return `PR ${pr} (свой, ${scenario === 'feedback' ? 'замечания' : 'правки'}): дерево на ${context.headRef}${stash ? `, stash «${stash}»` : ''}. Прогон открыт до конца раунда; закрыть вручную — /pr stop.${next}`
  }

  const who = context.isOwn ? 'свой — только отчёт' : context.state === 'closed' ? 'закрыт — только отчёт' : context.author
  return `PR ${pr} (${who}): дерево на ${switched.detached ? 'коммите PR' : context.headRef}${stash ? `, stash «${stash}»` : ''}${switched.baseFallback ? `, база ревью — от main: ветка ${context.baseRef} на сервере удалена` : ''}${switched.baseNote ? `, ${switched.baseNote}` : ''}. Прогон открыт до конца ревью; закрыть вручную — /pr stop.${next}`
}

export async function startConflict($: EngineInterface, pr: number): Promise<string> {
  const run = runner($)
  const facts = await runFacts($)
  if (facts?.status === 'active' && facts.pr === pr && facts.scenario === 'conflict') return conflictState($, pr, `Прогон PR ${pr} уже идёт.`)
  const loaded = await prContext($, pr)
  const { context } = loaded
  if (!context.isOwn) return `not started: PR ${pr} не ваш — конфликты разрешает автор`
  if (context.state === 'closed') return `not started: PR ${pr} закрыт`
  const operation = await operationInProgress(run)
  if (operation || (await unmergedPaths(run)).length) return `not started: в дереве идёт ${operation ?? 'разрешение конфликтов'} — закончите его сами`
  const opened = await startRun($, pr, { loaded, handoff: 'return', scenario: 'conflict' })
  const now = await runFacts($)
  if (now?.status !== 'active' || now.pr !== pr || now.scenario !== 'conflict') return `not started: ${opened}`
  return conflictState($, pr, opened)
}

export async function conflictState($: EngineInterface, pr: number, opened: string): Promise<string> {
  const run = runner($)
  const { dir, context } = await writeContext($, pr)
  if ((await operationInProgress(run)) === 'merge') {
    const left = await unmergedPaths(run)
    return left.length ? `${opened}\nconflicts:\n${left.join('\n')}` : `${opened}\nresolved: конфликты разрешены, слияние не закоммичено — commit_push`
  }
  const parents = (await gitText(run, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').slice(1)
  if (parents.length === 2 && (await unpushed(run, context.headRef)).length && (await isAncestor(run, `origin/${context.baseRef}`, 'HEAD'))) {
    const session = await readJson<Record<string, unknown>>($, `${dir}/session.json`, {})
    await $.fs.write(`${dir}/session.json`, JSON.stringify({ ...session, roundBase: parents[0] }))
    const subject = (await gitText(run, ['log', '-1', '--format=%s'])).trim()
    return `${opened}\nmerged: слияние «${subject}» уже закоммичено, но не запушено — commit_push с этим message`
  }
  const { conflicts } = await mergeBase(run, context.baseRef)
  if (conflicts.length) return `${opened}\nconflicts:\n${conflicts.join('\n')}`
  await finishRun($, pr, 'done')
  return `${opened}\nclean: конфликтов с ${context.baseRef} нет — база не вливалась, прогон закрыт`
}
