import { update, type Register, type EngineInterface, type HookStream, type ProcessSpawnChunk, type ProcessSpawnResult } from 'claude-code'
import { classifyBash, guardText } from './policy.ts'
import { manifestPaths, MAX_RETURNS, parseManifest, parseRole, unreadFiles, type GatedAgent } from './gate.ts'
import { ADAPTERS, createProvider, selectProvider, withTimeout, type ExplicitConfig } from './forge/index.ts'
import type { ForgeProvider } from './forge/types.ts'
import { ACTIONABLE, contextOf, pullRows, intakeItems, loadPr, priorComments, scenarioOf, type IntakeItem, type ListRow, type PrContext, type PrData } from './status.ts'
import { buildInput, B_SKIPPED, fileStates, lineCount, manifestText, notAttached, readRules, type TriageItem } from './run/input.ts'
import { collectFindings, finishTriage, type Finding, type GateRow, type Severity, type ThresholdRow } from './run/findings.ts'
import { applySwitch, branchCandidates, createReviewWorktree, excludeFile, shellQuote, changedFiles, claudeCodeChanges, commitRound, deleteBranches, foreignChanges, gitText, holder as worktreeHolder, inMainTree, messageProblem, planSwitch, pushRound, recheckBase, removeWorktrees, reviewStashes, roundState, snapshot, stashAction, unpushed, worktreeCandidates, type IsActive, type Run, type SwitchPlan } from './git.ts'
import { annotations, decisionOf, fixResult, parseMessage, reconcile } from './plannotator.ts'
import { buildDraft, buildReplies, parseCovered, statusesBlock, verdictName, type Texts } from './run/review.ts'

const RUN = { plugin: 'review-kit', key: 'run' } as const
const GATED_AGENT = { plugin: 'review-kit', key: 'gatedAgent' } as const
const CONFIRM_TEXT_LIMIT = 6000
const HTTP_TIMEOUT_MS = 30_000
const CONFIG_PATH = '.claude/review-kit.local.json'
const SETTINGS: { options: Record<string, unknown> } = { options: {} }
const MAX_DIALOG_OPTIONS = 4
const CLEANUP_MIN_BRANCHES_AFTER_RUN = 5
const KEEP = 'Оставить'
const BRANCH_GROUPS = [
  { kind: 'pr', title: 'Локальные ветки ревью, которые можно удалить (все коммиты есть на origin):' },
  { kind: 'no-pr', title: 'У этих веток нет PR среди последних — возможно, ваша работа без PR (все коммиты есть на origin):' },
]
const CANCEL = 'Отмена'
const WORKTREE_TITLE = 'Worktree законченных ревью (вкладки pr-tab) — удалить вместе с ненужными ветками?'
const CONTINUE_THERE = 'Продолжить там'
const CLEAR = 'Очистить'
const SCENARIO_TEXT = {
  'none-own': 'Замечаний к вашему PR нет.',
  'wait-author': 'Ждём автора: после вашего ревью нет ни новых коммитов, ни ответов в ваших тредах.',
} as const
const GUARD_FAILED = 'review-kit: guard failed — действие отклонено'
const ORCA_DEFAULT = 'orca.exe'
const WORKTREES_EXCLUDE = '/.claude/worktrees/'
const STATUS_ARGV = ['git', 'status', '--porcelain', '-uno', '--ignore-submodules=all']
const SUBMIT_ATTEMPTS = 5
const SESSION_POLLS = 20
const SESSION_POLL_MS = 500
type PlannotatorMode = 'review' | 'fix'

interface PlannotatorChild {
  stop: () => void
  mode: PlannotatorMode
  started: boolean
  exit?: number | null
}

const plannotatorChildren = new Map<number, PlannotatorChild>()

async function activeRun($: EngineInterface): Promise<number | undefined> {
  const { value } = await $.state.get(RUN)
  const run = value as { pr: number; status: string } | undefined
  return run?.status === 'active' ? run.pr : undefined
}

async function projectRoot($: EngineInterface): Promise<string> {
  const { stdout } = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
  return stdout.trim()
}

interface RunFacts {
  pr: number | undefined
  status: string
  isOwn: boolean
  state: string
  head: string
  scenario?: RunScenario
}

type Handoff = 'submit' | 'return'

async function runFacts($: EngineInterface): Promise<RunFacts | undefined> {
  return (await $.state.get(RUN)).value as RunFacts | undefined
}

async function runDir($: EngineInterface, pr: number): Promise<string> {
  return `${await projectRoot($)}/.review-kit/run/${pr}`
}

async function openRun($: EngineInterface, { pr, context, head, scenario }: { pr: number; context: PrContext; head: string; scenario: RunScenario }): Promise<void> {
  const own = scenario === 'feedback' || scenario === 'fix'
  const path = `${await runDir($, pr)}/session.json`
  const kept = (await readJson<{ roundBase?: string }>($, path, {})).roundBase
  await $.fs.write(path, JSON.stringify({ sessionId: await $.session.id(), status: 'active', ...(own ? { roundBase: kept ?? head } : {}) }))
  await $.state.set(RUN, { pr, status: 'active', isOwn: context.isOwn, state: context.state, head, scenario })
}

async function deleteRunDir($: EngineInterface, pr: number): Promise<void> {
  if (Number.isInteger(pr) && pr > 0) await $.process.run(['rm', '-rf', await runDir($, pr)])
}

async function foreignRun($: EngineInterface, pr: number): Promise<boolean> {
  const text = await $.fs.read(`${await runDir($, pr)}/session.json`).then(String, () => '')
  if (!text) return false
  try {
    const session = JSON.parse(text) as { sessionId: string; status: string }
    return session.status === 'active' && session.sessionId !== (await $.session.id())
  } catch {
    return true
  }
}

type RunScenario = 'review' | 'recheck' | 'feedback' | 'fix'

const READ_ONLY_SCENARIOS: readonly RunScenario[] = ['review', 'recheck']

const SKILL_OF: Record<RunScenario, string> = { review: 'pr-review-run', recheck: 'pr-recheck-run', feedback: 'pr-feedback-run', fix: 'pr-fix-run' }

function handOff($: EngineInterface, pr: number, handoff: Handoff, scenario: RunScenario = 'review'): string {
  const text = `Use the review-kit:${SKILL_OF[scenario]} skill for PR ${pr}; context: .review-kit/run/${pr}/context.json`
  if (handoff === 'return') return ` ${text}`

  submitLater($, text, SUBMIT_ATTEMPTS)
  return ''
}

function submitLater($: EngineInterface, text: string, attempts: number): void {
  $.clock.after(0, () => $.prompt.submit({ text }).catch(error => {
    if (attempts > 1 && /command\.run hook/.test(String(error))) return submitLater($, text, attempts - 1)
    $.ui.log(`review-kit: prompt.submit не прошёл: ${String(error)}`)
  }))
}

function parseSaved(text: string): { head?: string; scenario?: string } | undefined {
  try {
    return JSON.parse(text) as { head?: string; scenario?: string }
  } catch {
    return undefined
  }
}

type Loaded = { context: PrContext; data: PrData }

async function explicitConfig($: EngineInterface): Promise<ExplicitConfig | undefined> {
  const text = await $.fs.read(`${await projectRoot($)}/${CONFIG_PATH}`).then(String, () => '')
  if (!text) return undefined
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    const field = (key: string) => (typeof value[key] === 'string' ? value[key] as string : undefined)
    return { provider: field('provider'), host: field('host'), owner: field('owner'), repo: field('repo') }
  } catch {
    throw new Error(`${CONFIG_PATH}: не JSON`)
  }
}

async function readTokens($: EngineInterface): Promise<Map<string, string | undefined>> {
  return new Map([
    ['FORGEJO_TOKEN', await $.env.get('FORGEJO_TOKEN')],
    ['GITEA_TOKEN', await $.env.get('GITEA_TOKEN')],
  ])
}

async function forge($: EngineInterface): Promise<ForgeProvider> {
  const remote = await $.process.run(['git', 'remote', 'get-url', 'origin'])
  const values = await readTokens($)
  const missing = ADAPTERS.flatMap(adapter => adapter.tokenEnv).filter(name => !values.has(name))
  if (missing.length) throw new Error(`review-kit: мод не читает переменные ${missing.join(', ')} — добавьте их в readTokens`)
  const selection = selectProvider({
    options: SETTINGS.options, config: await explicitConfig($), remoteUrl: remote.exitCode === 0 ? remote.stdout.trim() : '',
    env: name => values.get(name),
  })
  if ('error' in selection) throw new Error(selection.error)
  const sleep = (ms: number) => $.clock.sleep(ms)
  return createProvider(selection, withTimeout((url, init) => $.http.fetch(url, init), sleep, HTTP_TIMEOUT_MS), sleep)
}

async function resumeRun($: EngineInterface, pr: number, handoff: Handoff): Promise<string> {
  const text = await $.fs.read(`${await runDir($, pr)}/context.json`).then(String, () => '')
  const saved = parseSaved(text)
  if (!saved?.head) return `Прогон PR ${pr} повреждён — выберите «Очистить».`
  const head = (await $.process.run(['git', 'rev-parse', 'HEAD'])).stdout.trim()
  if (head !== saved.head) return `Дерево сдвинуто после прерванного прогона PR ${pr} (${head.slice(0, 7)} вместо ${saved.head.slice(0, 7)}) — начните заново: «Очистить».`

  const fresh = (await prContext($, pr)).context
  const scenario = (saved.scenario && saved.scenario in SKILL_OF ? saved.scenario : 'review') as RunScenario
  await openRun($, { pr, context: fresh, head, scenario })
  return `Прогон PR ${pr} продолжен в этой сессии.${handOff($, pr, handoff, scenario)}`
}

async function finishRun($: EngineInterface, pr: number, status: 'done' | 'aborted'): Promise<void> {
  plannotatorChildren.get(pr)?.stop()
  await $.state.set(RUN, { pr, status, isOwn: false, state: 'closed', head: '' })
  await deleteRunDir($, pr)
}

async function readGatedAgent($: EngineInterface, agentId: string | undefined): Promise<GatedAgent | undefined> {
  if (agentId === undefined) return undefined
  const agent = (await $.state.get({ ...GATED_AGENT, id: agentId })).value as GatedAgent | undefined
  return agent && agent.pr === (await activeRun($)) ? agent : undefined
}

function changeGatedAgent($: EngineInterface, agentId: string, change: (agent: GatedAgent) => GatedAgent): Promise<unknown> {
  return update($, { ...GATED_AGENT, id: agentId }, value => change(value as GatedAgent))
}

async function gateDir($: EngineInterface, { pr, role, manifest }: { pr: number; role: unknown; manifest?: string }): Promise<string> {
  const root = await projectRoot($)
  if (manifest) return `${manifest.startsWith('/') ? '' : `${root}/`}${manifest.slice(0, manifest.lastIndexOf('/'))}`
  return `${root}/.review-kit/run/${pr}/${role === 'triage' ? 'triage' : 'funnel'}`
}

async function gateLog($: EngineInterface, agent: { pr: number; role: unknown; manifest?: string }, agentId: string, row: Record<string, unknown>): Promise<void> {
  const path = `${await gateDir($, agent)}/gate-${agentId}.jsonl`
  const before = await $.fs.read(path).then(String, () => '')
  await $.fs.write(path, `${before}${JSON.stringify({ agentId, ...row })}\n`)
}

async function manifestOf($: EngineInterface, agent: GatedAgent): Promise<string[] | undefined> {
  return $.fs.read(`${await gateDir($, agent)}/manifest-${agent.role}.txt`).then(text => manifestPaths(String(text)), () => undefined)
}

interface SavedStash {
  name: string
  sha: string
}

async function stashTop($: EngineInterface): Promise<string> {
  return (await $.process.run(['git', 'rev-parse', '-q', '--verify', 'refs/stash'])).stdout.trim()
}

async function stashOrCancel($: EngineInterface, pr: number): Promise<SavedStash | 'cancel'> {
  const answer = await $.ui.ask(`В дереве есть незакоммиченные изменения. Ревью PR ${pr} переключит ветку.`, ['Убрать в stash', 'Отменить'])
  if (answer !== 'Убрать в stash') return 'cancel'

  const now = (await $.process.run(['date', '+%Y-%m-%d %H:%M:%S'])).stdout.trim()
  const name = `review-kit: pr-${pr} ${now}`
  const before = await stashTop($)
  await gitText(runner($), ['stash', 'push', '-m', name])
  const sha = await stashTop($)
  if (!sha || sha === before) throw new Error('stash не создан — дерево не тронуто')
  return { name, sha }
}

async function switchOrRestore($: EngineInterface, { plan, stash }: { plan: SwitchPlan; stash: SavedStash | null }): Promise<{ head: string; base: string; detached: boolean; baseFallback: boolean }> {
  const run = runner($)
  const before = (await gitText(run, ['rev-parse', 'HEAD'])).trim()
  try {
    return await applySwitch(run, plan)
  } catch (error) {
    if (!stash) throw error
    const after = (await gitText(run, ['rev-parse', 'HEAD'])).trim()
    if (after !== before) throw new Error(`${(error as Error).message}; дерево уже на коммите PR; stash «${stash.name}» не применён — вернитесь (git switch -) и примените его через /pr cleanup`)
    const restored = await stashAction(run, stash.sha, 'apply')
    const note = restored.ok ? 'изменения возвращены из stash' : restored.conflict ? `изменения из stash «${stash.name}» ${restored.error}` : `изменения остались в stash «${stash.name}»: ${restored.error}`
    throw new Error(`${(error as Error).message}; ${note}`)
  }
}

async function prContext($: EngineInterface, pr: number): Promise<Loaded> {
  const data = await loadPr(await forge($), pr)
  return { context: contextOf(data, scenarioOf(data)), data }
}

interface ReviewWorktreeCandidate {
  path: string
  pr: number
  branch: string
  deleteBranch: boolean
}

function worktreeLine({ pr, path, branch, deleteBranch }: ReviewWorktreeCandidate): string {
  const fate = !branch ? 'без ветки' : deleteBranch ? `ветка ${branch} удалится` : `ветка ${branch} останется`
  return `#${pr} ${path.split('/').pop()} — ${fate}`
}

async function offerWorktrees($: EngineInterface, { worktrees }: { worktrees: ReviewWorktreeCandidate[] }): Promise<string | undefined> {
  const remove = `Удалить все (${worktrees.length})`
  if ((await $.ui.ask(`${WORKTREE_TITLE}\n${worktrees.map(worktreeLine).join('\n')}`, [remove, KEEP]).catch(() => KEEP)) !== remove) return undefined
  const run = runner($)
  const result = await removeWorktrees(run, worktrees.map(w => w.path), { confirmed: false, isActive: isActive($) })
  const branches = worktrees.filter(w => w.deleteBranch && result.removed.includes(w.path)).map(w => w.branch)
  const deleted = branches.length ? (await deleteBranches(run, branches)).deleted : []
  const skipped = result.skipped.length ? `, пропущено: ${result.skipped.map(s => `${s.path.split('/').pop()} (${s.reason})`).join(', ')}` : ''
  return `удалено worktree: ${result.removed.length}${deleted.length ? `, их веток: ${deleted.length}` : ''}${skipped}`
}

async function releaseWorktree($: EngineInterface, { pr, headRef }: { pr: number; headRef: string }): Promise<string | undefined> {
  const held = await worktreeHolder(runner($), headRef, isActive($))
  if (!held) return undefined

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

async function offerCleanup($: EngineInterface, { minBranches }: { minBranches: number }): Promise<string> {
  const run = runner($)
  const provider = await forge($)
  const [open, closed, me] = await Promise.all([provider.listPulls('open'), provider.listPulls('closed'), provider.currentUser()])
  const found = {
    branches: await branchCandidates(run, { open, closed, me }),
    stashes: await reviewStashes(run),
    worktrees: (await inMainTree(run)) ? await worktreeCandidates(run, { open, me, isActive: isActive($) }) : [],
  }
  const worktrees = found.worktrees ?? []
  const branchesDue = found.branches.length > minBranches
  const stashes = minBranches === 0 || branchesDue ? found.stashes : []
  if (worktrees.length === 0 && !branchesDue && stashes.length === 0) return ''

  const done: string[] = []
  const removed = worktrees.length ? await offerWorktrees($, { worktrees }) : undefined
  if (removed) done.push(removed)

  for (const group of branchesDue ? BRANCH_GROUPS : []) {
    const branches = found.branches.filter(b => b.kind === group.kind)
    if (branches.length === 0) continue
    const remove = `Удалить все (${branches.length})`
    const list = branches.map(b => `${b.name} — ${b.reason}`).join('\n')
    if ((await $.ui.ask(`${group.title}\n${list}`, [remove, KEEP]).catch(() => KEEP)) !== remove) continue
    const result = await deleteBranches(run, branches.map(b => b.name))
    done.push(`удалено веток: ${result.deleted.length}${result.skipped.length ? `, пропущено: ${result.skipped.map(item => item.name).join(', ')}` : ''}`)
  }

  for (const stash of stashes) {
    const branch = (await $.process.run(['git', 'branch', '--show-current'])).stdout.trim()
    const clean = (await $.process.run(STATUS_ARGV)).stdout.trim() === ''
    const canApply = clean && stash.branch !== '' && branch === stash.branch
    const hint = canApply || !stash.branch ? '' : ` — чтобы применить, переключитесь на ${stash.branch}${clean ? '' : ' и уберите изменения'}`
    const options = canApply ? [KEEP, 'Применить', 'Удалить'] : [KEEP, 'Удалить']
    const answer = await $.ui.ask(`Stash «${stash.message}» (из ветки ${stash.branch || '—'})${hint}`, options).catch(() => KEEP)
    if (answer === KEEP) continue
    const result = await stashAction(run, stash.sha, answer === 'Удалить' ? 'drop' : 'apply')
    done.push(result.ok ? `stash «${stash.message}»: ${answer.toLowerCase()}` : result.conflict ? `stash «${stash.message}» ${result.error}` : `stash «${stash.message}» не применён: ${result.error}`)
  }
  return done.length ? `Уборка: ${done.join('; ')}.` : 'Уборка: ничего не тронуто.'
}

async function withCleanup($: EngineInterface, text: string, minBranches: number): Promise<string> {
  try {
    const cleanup = await offerCleanup($, { minBranches })
    return cleanup ? `${text}\n${cleanup}` : text
  } catch (error) {
    return `${text}\nуборка пропущена: ${(error as Error).message}`
  }
}

function closedText(context: PrContext): string {
  return context.merged ? `PR ${context.number} влит — сценариев нет. Отчёт по нему: /pr-review ${context.number}` : `PR ${context.number} закрыт без слияния — сценариев нет.`
}

async function askAboutActive($: EngineInterface, pr: number | undefined): Promise<string | undefined> {
  const active = await activeRun($)
  if (active === undefined) return undefined

  if (active === pr) {
    const answer = await $.ui.ask(`Прогон PR ${pr} уже идёт.`, ['Вернуться к нему', 'Начать заново']).catch(() => undefined)
    if (answer !== 'Начать заново') return `Продолжаем PR ${pr}.`
    await finishRun($, pr, 'aborted')
    return undefined
  }

  const question = pr === undefined ? `Идёт прогон PR ${active}.` : `Идёт прогон PR ${active}. Начать PR ${pr}?`
  const answer = await $.ui.ask(question, [`Вернуться к PR ${active}`, `Прервать PR ${active}`]).catch(() => undefined)
  if (answer !== `Прервать PR ${active}`) return `Продолжаем PR ${active}.`
  await finishRun($, active, 'aborted')
  return undefined
}

async function routePr($: EngineInterface, pr: number | undefined, handoff: Handoff): Promise<string> {
  if (pr === undefined) {
    const stop = await askAboutActive($, undefined)
    if (stop) return stop

    const { rows, truncated } = await pullRows(await forge($))
    const actionable = rows.filter(row => ACTIONABLE.includes(row.scenario))
    const line = (row: ListRow) => `#${row.number} ${row.status} — ${row.title}`
    const tail = truncated ? '\nПрочитано 50 открытых PR — это предел одного запроса; если PR больше, остальные — /pr <номер>' : ''
    if (actionable.length === 0) return withCleanup($, rows.length ? `Открытые PR:\n${rows.map(line).join('\n')}\nДелать нечего.${tail}` : 'Открытых PR нет.', 0)
    const labels = actionable.map(line)
    const others = rows.filter(row => !actionable.includes(row))
    const rest = others.length ? `\nОстальные:\n${others.map(line).join('\n')}` : ''
    if (actionable.length > MAX_DIALOG_OPTIONS) return `PR, по которым есть дело:\n${labels.join('\n')}${rest}\nВыберите: /pr <номер>${tail}`

    const chosen = String(await $.ui.ask('Какой PR берём?', actionable.length === 1 ? [...labels, CANCEL] : labels).catch(() => ''))
    const row = actionable[labels.indexOf(chosen)]
    if (row) return routePr($, row.number, handoff)

    const typed = /^#?(\d+)$/.exec(chosen.trim())
    return typed ? routePr($, Number(typed[1]), handoff) : withCleanup($, 'Отменено.', 0)
  }

  const loaded = await prContext($, pr)
  const { context } = loaded
  if (context.scenario === 'review') return startReview($, pr, { loaded, handoff })
  if (context.scenario === 'feedback') return startFix($, pr, { loaded, handoff, scenario: 'feedback' })
  if (context.scenario === 'recheck') return startReview($, pr, { loaded, handoff, scenario: 'recheck' })
  return context.scenario === 'closed' ? closedText(context) : SCENARIO_TEXT[context.scenario]
}

async function startReview($: EngineInterface, pr: number, { loaded, handoff, scenario = 'review' }: { loaded: Loaded; handoff: Handoff; scenario?: 'review' | 'recheck' }): Promise<string> {
  const { context } = loaded
  if (context.state === 'closed' && !context.merged) return `PR ${pr} закрыт без слияния — ревью не делаю.`
  if (scenario === 'recheck' && context.isOwn) return `PR ${pr} — свой PR: перепроверка только чужого, замечания к своему — /pr-feedback ${pr}.`
  return startRun($, pr, { loaded, handoff, scenario })
}

async function startFix($: EngineInterface, pr: number, { loaded, handoff, scenario }: { loaded: Loaded; handoff: Handoff; scenario: 'feedback' | 'fix' }): Promise<string> {
  const { context } = loaded
  if (!context.isOwn) return `PR ${pr} не ваш: замечания и правки — только свой PR. Ревью чужого — /pr-review ${pr}.`
  if (context.state === 'closed') return `PR ${pr} закрыт — правок нет.`
  return startRun($, pr, { loaded, handoff, scenario })
}

async function startRun($: EngineInterface, pr: number, { loaded, handoff, scenario }: { loaded: Loaded; handoff: Handoff; scenario: RunScenario }): Promise<string> {
  const { context } = loaded
  const stop = await askAboutActive($, pr)
  if (stop) return stop

  if (await foreignRun($, pr)) {
    const question = `Прогон PR ${pr} открыт в другой сессии. Если та вкладка ещё открыта — сначала закройте прогон там.`
    const answer = await $.ui.ask(question, ['Продолжить здесь', 'Очистить', 'Отмена']).catch(() => undefined)
    if (answer === 'Продолжить здесь') return resumeRun($, pr, handoff)
    if (answer !== 'Очистить') return 'Отменено: дерево не тронуто.'
    await deleteRunDir($, pr)
  }

  const held = await releaseWorktree($, { pr, headRef: context.headRef })
  if (held) return held

  const root = await projectRoot($)

  const reviewing = scenario === 'review' || scenario === 'recheck'
  const model = await $.ui.ask(`Модель для ${reviewing ? 'ревью' : 'разбора замечаний'} PR ${pr}?`, ['opus', 'sonnet', 'haiku']).catch(() => undefined)
  if (!model) return 'Отменено: дерево не тронуто.'

  const run = runner($)
  const provider = await forge($)
  const plan = await planSwitch(run, { number: pr, headRef: context.headRef, headSha: context.headSha, baseRef: context.baseRef, own: context.isOwn, pullRef: provider.pullRef(pr) })
  if (!context.isOwn) {
    const risky = claudeCodeChanges(await changedFiles(run, plan.base, plan.target))
    if (risky.length) {
      const answer = await $.ui.ask(`PR ${pr} меняет настройки Claude Code:\n${risky.join('\n')}\nХуки и MCP из них могут выполнить команды на вашей машине, когда дерево переключится на PR.`, ['Отмена', 'Продолжить']).catch(() => 'Отмена')
      if (answer !== 'Продолжить') return 'Отменено: дерево не тронуто.'
    }
  }

  const dirty = (await $.process.run(STATUS_ARGV)).stdout.trim()
  const saved = dirty ? await stashOrCancel($, pr) : null
  if (saved === 'cancel') return 'Отменено: дерево не тронуто.'
  const stash = saved?.name ?? null

  const switched = await switchOrRestore($, { plan, stash: saved })
  await deleteRunDir($, pr)
  const dir = `${root}/.review-kit/run/${pr}`
  if (scenario === 'feedback' || scenario === 'fix') {
    await $.fs.write(`${dir}/intake.json`, JSON.stringify({ head: context.headSha, items: intakeItems(loaded.data) }, null, 2))
  }
  if (scenario === 'recheck') {
    const prior = priorComments(loaded.data)
    if (!prior) throw new Error(`моего ревью в PR ${pr} нет — перепроверять нечего; дерево на коммите PR${stash ? `, ваши изменения в stash «${stash}» — вернуть: /pr cleanup` : ''}`)
    const base = await recheckBase(argv => $.process.run(argv), { lastCommit: prior.review.commitSha, head: switched.head, baseRef: context.baseRef })
    await $.fs.write(`${dir}/recheck.json`, JSON.stringify({ ...base, reviewId: prior.review.id, prior: prior.prior }, null, 2))
  }
  const plannotator = await $.process.run(['plannotator', '--version']).then(result => result.exitCode === 0, () => false)
  await $.fs.write(`${dir}/context.json`, JSON.stringify({ ...context, ...switched, stash, model, scenario, plannotator }))
  await openRun($, { pr, context, head: switched.head, scenario })
  const next = handOff($, pr, handoff, scenario)

  if (scenario === 'feedback' || scenario === 'fix') {
    return `PR ${pr} (свой, ${scenario === 'feedback' ? 'замечания' : 'правки'}): дерево на ${context.headRef}${stash ? `, stash «${stash}»` : ''}, модель ${model}. Прогон открыт до конца раунда; закрыть вручную — /pr-${scenario} stop.${next}`
  }

  const who = context.isOwn ? 'свой — только отчёт' : context.state === 'closed' ? 'закрыт — только отчёт' : context.author
  return `PR ${pr} (${who}): дерево на ${switched.detached ? 'коммите PR' : context.headRef}${stash ? `, stash «${stash}»` : ''}, модель ${model}${switched.baseFallback ? `, база ревью — от main: ветка ${context.baseRef} на сервере удалена` : ''}. Прогон открыт до конца ревью; закрыть вручную — /pr-review stop.${next}`
}

type PrepareKind = 'review' | 'recheck' | 'feedback' | 'fix-check'
type WorkflowId = 'funnel' | 'delta' | 'statuses' | 'triage' | 'fix-check'
interface WorkflowSpec { id: WorkflowId; scriptPath: string; args: Record<string, unknown> }

function runner($: EngineInterface): Run {
  return (argv, init) => $.process.run(argv, init)
}

async function runContext($: EngineInterface, pr: number): Promise<{ dir: string; context: { head: string; base: string; model: string } }> {
  if ((await activeRun($)) !== pr) throw new Error(`нет активного прогона PR ${pr}`)
  const dir = await runDir($, pr)
  return { dir, context: JSON.parse(String(await $.fs.read(`${dir}/context.json`))) }
}

async function writeWorkflow($: EngineInterface, w: { pr: number; dir: string; id: WorkflowId; base: string; head: string; rulesRev: string; model: string; foreign: boolean; items?: TriageItem[]; mode?: 'feedback' | 'recheck' }): Promise<{ spec: WorkflowSpec; notes: string[] }> {
  const run = runner($)
  const out = `${w.dir}/${w.id}`
  const sha = async (rev: string) => (await gitText(run, ['rev-parse', rev])).trim()
  const [base, head, rulesRev] = await Promise.all([sha(w.base), sha(w.head), sha(w.rulesRev)])
  const { rules, changedRules } = await readRules(run, { rev: rulesRev, base, head })
  const input = await buildInput(run, { base, head, rules, items: w.items })
  const notes = [
    ...(!w.items && rules.size === 0 ? [B_SKIPPED] : []),
    ...(w.foreign && changedRules.length ? [`PR меняет правила агентов: ${changedRules.join(', ')} — ревью шло по правилам базы`] : []),
  ]
  await $.process.run(['rm', '-rf', out])
  await Promise.all([...rules].map(([path, text]) => $.fs.write(`${out}/rules/${path}`, text)))
  await $.fs.write(`${out}/rules.json`, JSON.stringify(Object.fromEntries(rules)))
  await $.fs.write(`${out}/range.json`, JSON.stringify({ base, head }))
  await $.fs.write(`${out}/input.md`, input)
  const script = `${w.items ? 'triage' : 'review-funnel'}.js`
  await $.fs.write(`${out}/${script}`, String(await $.fs.read(`${$.plugin.root}/funnel/${script}`)))
  const copies = [...rules.keys()].map(path => `${out}/rules/${path}`)
  const roles = w.items ? [] : rules.size ? ['correctness', 'quality'] : ['correctness']
  for (const role of w.items ? ['triage'] : [...roles, 'refuter']) await $.fs.write(`${out}/manifest-${role}.txt`, manifestText(copies, notes))
  const rel = `.review-kit/run/${w.pr}/${w.id}`
  const args = w.items
    ? { pr: w.pr, mode: w.mode, input: `${rel}/input.md`, manifestDir: rel, model: w.model, ids: w.items.map(item => item.id) }
    : { pr: w.pr, input: `${rel}/input.md`, manifestDir: rel, roles, model: w.model }
  return { spec: { id: w.id, scriptPath: `${out}/${script}`, args }, notes }
}

async function prepare($: EngineInterface, pr: number, kind: PrepareKind, paths: string[]): Promise<{ workflows: WorkflowSpec[]; notes: string[] }> {
  const { dir, context } = await runContext($, pr)
  const base = { pr, dir, model: context.model }
  const parts: Array<{ spec: WorkflowSpec; notes: string[] }> = []
  if (kind === 'review') parts.push(await writeWorkflow($, { ...base, id: 'funnel', base: context.base, head: context.head, rulesRev: context.base, foreign: true }))
  if (kind === 'recheck') {
    const recheck = JSON.parse(String(await $.fs.read(`${dir}/recheck.json`))) as { base: string; prior: TriageItem[] }
    parts.push(await writeWorkflow($, { ...base, id: 'statuses', base: recheck.base, head: context.head, rulesRev: context.base, foreign: true, items: recheck.prior, mode: 'recheck' }))
    parts.push(await writeWorkflow($, { ...base, id: 'delta', base: recheck.base, head: context.head, rulesRev: context.base, foreign: true }))
  }
  if (kind === 'feedback') {
    const intake = JSON.parse(String(await $.fs.read(`${dir}/intake.json`))) as { items: TriageItem[] }
    parts.push(await writeWorkflow($, { ...base, id: 'triage', base: context.base, head: 'HEAD', rulesRev: 'HEAD', foreign: false, items: intake.items, mode: 'feedback' }))
  }
  if (kind === 'fix-check') {
    const head = await snapshot(runner($), { paths, indexFile: `${dir}/snapshot.index` })
    parts.push(await writeWorkflow($, { ...base, id: 'fix-check', base: 'HEAD', head, rulesRev: 'HEAD', foreign: false }))
  }
  if (parts.length === 0) throw new Error(`неизвестный вид подготовки ${kind}`)
  return { workflows: parts.map(part => part.spec), notes: [...new Set(parts.flatMap(part => part.notes))] }
}

async function workflowNotes($: EngineInterface, out: string): Promise<{ manifestNotes: string[]; gateRows: GateRow[] }> {
  const names = (await $.process.run(['ls', '-1', out])).stdout.split('\n').filter(Boolean)
  const read = (name: string) => $.fs.read(`${out}/${name}`).then(String, () => '')
  const manifests = await Promise.all(names.filter(name => /^manifest-.*\.txt$/.test(name)).sort().map(read))
  const gates = await Promise.all(names.filter(name => /^gate-.*\.jsonl$/.test(name)).sort().map(read))
  return {
    manifestNotes: [...new Set(manifests.flatMap(text => text.split('\n')).filter(line => line.startsWith('# ')).map(line => line.slice(2)))],
    gateRows: gates.flatMap(text => text.split('\n').filter(Boolean).map(line => JSON.parse(line) as GateRow)),
  }
}

async function collect($: EngineInterface, pr: number, id: WorkflowId, outputFile: string): Promise<string> {
  const { dir } = await runContext($, pr)
  const out = `${dir}/${id}`
  const text = String(await $.fs.read(outputFile))
  await $.fs.write(`${out}/raw.json`, text)
  const raw = JSON.parse(text) as unknown
  if (id === 'triage' || id === 'statuses') {
    const source = JSON.parse(String(await $.fs.read(`${dir}/${id === 'triage' ? 'intake' : 'recheck'}.json`))) as { items?: TriageItem[]; prior?: TriageItem[] }
    const items = finishTriage(raw, source.items ?? source.prior ?? [], id === 'triage' ? 'feedback' : 'recheck')
    const result = JSON.stringify({ items }, null, 2)
    await $.fs.write(`${dir}/${id === 'triage' ? 'triage' : 'statuses'}.json`, result)
    return result
  }
  const run = runner($)
  const { base, head } = JSON.parse(String(await $.fs.read(`${out}/range.json`))) as { base: string; head: string }
  const rules = new Map(Object.entries(JSON.parse(String(await $.fs.read(`${out}/rules.json`))) as Record<string, string>))
  const states = await fileStates(run, base, head)
  const lineCounts = new Map([...states].filter(([, s]) => s.text !== null).map(([path, s]) => [path, lineCount(s.text ?? '')]))
  const table = (JSON.parse(String(await $.fs.read(`${$.plugin.root}/config/funnel.json`))) as { threshold: ThresholdRow[] }).threshold
  const result = collectFindings({
    raw, changed: await changedFiles(run, base, head), lineCounts, rules, skipped: notAttached(states), table, ...(await workflowNotes($, out)),
    ...(id === 'delta' ? { minSeverity: 'important' as Severity } : {}),
  })
  const json = JSON.stringify(result, null, 2)
  await $.fs.write(id === 'fix-check' ? `${out}/findings.json` : `${dir}/findings.json`, json)
  return json
}

function isActive($: EngineInterface): IsActive {
  return (path, pr) => $.fs.read(`${path}/.review-kit/run/${pr}/session.json`).then(text => {
    try {
      return (JSON.parse(String(text)) as { status?: string }).status === 'active'
    } catch {
      return true
    }
  }, () => false)
}

async function writeContext($: EngineInterface, pr: number): Promise<{ dir: string; context: PrContext & { head: string; base: string } }> {
  if ((await activeRun($)) !== pr) throw new Error(`нет активного прогона PR ${pr} в этой сессии`)
  const dir = await runDir($, pr)
  return { dir, context: JSON.parse(String(await $.fs.read(`${dir}/context.json`))) }
}

async function readJson<T>($: EngineInterface, path: string, fallback: T): Promise<T> {
  return $.fs.read(path).then(text => JSON.parse(String(text)) as T, () => fallback)
}

async function publishReview($: EngineInterface, { pr, ids, approve, from }: { pr: number; ids: string[] | 'all'; approve?: boolean; from?: 'chat' | 'plannotator' }): Promise<string> {
  const { dir, context } = await writeContext($, pr)
  if (context.isOwn || context.state === 'closed') return 'not published: свой или закрытый PR не публикуется — только отчёт'
  const source = from === 'plannotator' ? `${dir}/plannotator` : dir
  const findings = (await readJson<{ findings: Finding[] }>($, `${source}/findings.json`, { findings: [] })).findings
  const texts = await readJson<Texts>($, `${source}/texts.json`, { comments: {} })
  const wanted = ids === 'all' ? findings.map(item => item.id) : ids
  const unknown = wanted.filter(id => !findings.some(item => item.id === id))
  if (unknown.length) return `not published: нет находки: ${unknown.join(', ')}`
  const selected = findings.filter(item => wanted.includes(item.id))
  const recheck = context.scenario === 'recheck'
  const statuses = recheck ? (await readJson<{ items: Array<{ id: string; class: string; reason?: string }> }>($, `${dir}/statuses.json`, { items: [] })).items : []
  const prior = (await readJson<{ prior: Array<{ id: string; path: string | null; line: number | null }> }>($, `${dir}/recheck.json`, { prior: [] })).prior
  const summary = [texts.summary?.trim() ?? '', ...(statuses.length ? [statusesBlock(statuses, prior)] : [])].filter(Boolean).join('\n\n')
  const provider = await forge($)
  const covered = parseCovered(await gitText(runner($), ['diff', '-U0', '--no-color', '--no-renames', context.base, context.head]))
  const verdict = verdictName(selected, statuses)
  const { draft, notes } = buildDraft({ selected, texts: { ...texts, summary }, verdict, approve: approve === true, covered, capabilities: provider.capabilities })
  const bare = draft.verdict === 'approve' && !draft.body.trim() && draft.comments.length === 0
  const inline = draft.comments.map(c => `• ${c.path}:${c.line} — ${c.body}`).join('\n')
  const question = bare ? `Одобрить PR ${pr} без комментариев?` : `Публикуем ревью PR ${pr} (${verdict})?\n\n${draft.body}\n\n${inline}`.slice(0, CONFIRM_TEXT_LIMIT)
  if ((await $.ui.ask(question, ['Да', 'Нет']).catch(() => 'Нет')) !== 'Да') return 'not published: пользователь отказал'
  if (!bare && draft.verdict === 'approve' && (await $.ui.ask(`Одобрить PR ${pr}?`, ['Да', 'Нет']).catch(() => 'Нет')) !== 'Да') {
    return 'not published: одобрение отклонено — вызовите review_publish без approve'
  }
  const { url } = await provider.publishReview(pr, draft)
  return `published: ${url}${notes.length ? `\n${notes.join('\n')}` : ''}`
}

async function publishReplies($: EngineInterface, pr: number): Promise<string> {
  const { dir, context } = await writeContext($, pr)
  if (!context.isOwn || context.state === 'closed') return 'not published: ответы — только в своём открытом PR'
  const items = (await readJson<{ items: IntakeItem[] }>($, `${dir}/intake.json`, { items: [] })).items
  const texts = (await readJson<{ replies: Record<string, string> }>($, `${dir}/replies.json`, { replies: {} })).replies
  const replies = buildReplies(items, texts)
  if (replies.length === 0) return 'not published: ответов нет'
  const byId = new Map(items.map(item => [item.id, item]))
  const lines = Object.entries(texts).filter(([, text]) => text.trim()).map(([id, text]) => {
    const item = byId.get(id)
    return `• ${item?.path ? `${item.path}:${item.position}` : 'общий'} — ${text.trim()}`
  }).join('\n\n')
  if ((await $.ui.ask(`Публикуем ответы в PR ${pr} (${replies.length})?\n\n${lines}`.slice(0, CONFIRM_TEXT_LIMIT), ['Да', 'Нет']).catch(() => 'Нет')) !== 'Да') return 'not published: пользователь отказал'
  await (await forge($)).publishReplies(pr, replies)
  return `published: ${replies.length}`
}

async function commitPush($: EngineInterface, { pr, message, paths }: { pr: number; message: string; paths: string[] }): Promise<string> {
  const { dir, context } = await writeContext($, pr)
  if (!context.isOwn || context.state === 'closed') return 'not done: commit и push — только свой открытый PR'
  const problem = messageProblem(message)
  if (problem) return `not done: ${problem}`
  const run = runner($)
  const branch = (await gitText(run, ['branch', '--show-current'])).trim()
  if (branch !== context.headRef) return `not done: дерево на ветке ${branch || '(detached)'}, а PR — ${context.headRef}`
  const session = await readJson<{ roundBase?: string }>($, `${dir}/session.json`, {})
  if (!session.roundBase) return 'not done: у прогона нет базы раунда — начните раунд заново (/pr-fix)'
  const { state, roundBase } = await roundState(run, { branch, roundBase: session.roundBase, message })
  if (roundBase !== session.roundBase) await $.fs.write(`${dir}/session.json`, JSON.stringify({ ...session, roundBase }))
  if (state === 'pushed') return `pushed: коммит раунда «${message}» уже на origin`
  if (state === 'commit') {
    const foreign = await foreignChanges(run, paths)
    if (foreign.length) return `not done: изменены файлы вне списка раунда — добавьте их в paths или верните:\n${foreign.join('\n')}`
  }
  const pending = await unpushed(run, branch)
  const what = state === 'commit' ? `Коммитим и пушим в ${branch} (PR ${pr})?\n\n${message}\n\nФайлы:\n${paths.join('\n')}` : `Пушим в ${branch} (PR ${pr}) коммит раунда «${message}»?`
  const question = `${what}${pending.length ? `\n\nУйдут и неотправленные коммиты:\n${pending.join('\n')}` : ''}`.slice(0, CONFIRM_TEXT_LIMIT)
  if ((await $.ui.ask(question, ['Да', 'Нет']).catch(() => 'Нет')) !== 'Да') return 'not done: пользователь отказал'
  if (state === 'commit') {
    const committed = await commitRound(run, { paths, message })
    if (!committed.ok) return `not done: коммита нет — ${committed.output}`
  }
  const pushed = await pushRound(run, branch)
  if (pushed.ok) return `pushed: ${(await gitText(run, ['rev-parse', '--short', 'HEAD'])).trim()} в ${branch}`
  return pushed.rejected
    ? `not pushed: ветка на origin ушла вперёд — нужен pull/rebase. Пусть пользователь выполнит \`! git pull --rebase\` (или в своём терминале), затем снова commit_push.\n${pushed.output}`
    : `not pushed: push не прошёл (коммит раунда сохранён, повтор commit_push только запушит): ${pushed.output}`
}

async function openTabs($: EngineInterface, prs: number[]): Promise<string> {
  const run = runner($)
  const provider = await forge($)
  const root = (await gitText(run, ['worktree', 'list', '--porcelain'])).split('\n')[0].slice('worktree '.length)
  const exclude = await excludeFile(run)
  const excluded = await $.fs.read(exclude).then(String, () => '')
  if (!excluded.split('\n').includes(WORKTREES_EXCLUDE)) await $.fs.write(exclude, `${excluded}${excluded && !excluded.endsWith('\n') ? '\n' : ''}${WORKTREES_EXCLUDE}\n`)
  const orca = (await $.env.get('ORCA_BIN')) ?? ORCA_DEFAULT
  const hasOrca = await $.process.run([orca, '--version']).then(result => result.exitCode === 0, () => false)
  if (!hasOrca) {
    submitLater($, `/pr-review ${prs[0]}`, SUBMIT_ATTEMPTS)
    return `Orca не найдена — ревью PR ${prs[0]} запускаю в текущем дереве${prs.length > 1 ? `; остальные (${prs.slice(1).join(', ')}) — потом: /pr-review <номер>` : ''}`
  }
  const lines: string[] = []
  const here: number[] = []
  for (const number of prs) {
    const pull = await provider.getPull(number)
    if (pull.state === 'closed') { lines.push(`PR ${number} закрыт — вкладку не открываю`); continue }
    const tree = await createReviewWorktree(run, { root, number, headRef: pull.headRef, headSha: pull.headSha, baseRef: pull.baseRef, pullRef: provider.pullRef(number), isActive: isActive($) })
      .catch((error: Error) => ({ error: error.message }))
    if ('error' in tree) { lines.push(`PR ${number}: ${tree.error}`); continue }
    if (tree.risky.length) { lines.push(`PR ${number} меняет настройки Claude Code (${tree.risky.join(', ')}) — вкладку с новой сессией в режиме auto не открываю: там хуки и MCP из PR сработали бы без вопросов. Ревью здесь: /pr-review ${number} — мод спросит перед переключением дерева`); continue }
    const command = `cd ${shellQuote(tree.path)} && claude --permission-mode auto ${shellQuote(`/pr-review ${number}`)}`
    const opened = await $.process.run([orca, 'terminal', 'create', '--worktree', `path:${root}`, '--title', `review #${number}`, '--focus', '--json', '--command', command]).then(result => result.exitCode === 0, () => false)
    if (opened) lines.push(`PR ${number}: вкладка открыта (${tree.created ? 'новый' : 'прежний'} worktree ${tree.path})`)
    else here.push(number)
  }
  if (here.length) {
    lines.push(`Вкладку Orca открыть не удалось — ревью PR ${here[0]} запускаю в текущем дереве${here.length > 1 ? `; остальные (${here.slice(1).join(', ')}) — потом: /pr-review <номер>` : ''}. Неиспользованные worktree уберёт /pr cleanup`)
    submitLater($, `/pr-review ${here[0]}`, SUBMIT_ATTEMPTS)
  }
  return lines.join('\n')
}

function sessionProject(root: string): string {
  return (root.split('/').pop() ?? '').toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-')
}

async function sessionUrls($: EngineInterface, project: string): Promise<string[]> {
  const { stdout, stderr } = await $.process.run(['plannotator', 'sessions'])
  return `${stdout}\n${stderr}`.split('\n').map(line => line.trim().split(/\s+/)).filter(cols => cols[1] === 'review' && cols[2] === project).map(cols => cols[3])
}

async function awaitSessionUrl($: EngineInterface, { project, child }: { project: string; child: PlannotatorChild }): Promise<string | undefined> {
  for (let poll = 0; poll < SESSION_POLLS && child.exit === undefined; poll++) {
    const urls = await sessionUrls($, project)
    if (urls.length > 1) return undefined
    if (urls.length === 1) return urls[0]
    await $.clock.sleep(SESSION_POLL_MS)
  }
  return undefined
}

function wake($: EngineInterface, text: string): void {
  $.prompt.submit({ text }).catch(error => $.ui.log(`review-kit: prompt.submit не прошёл: ${String(error)}`))
}

async function settlePlannotator($: EngineInterface, { pr, dir, stdout, code }: { pr: number; dir: string; stdout: string; code: number | null }): Promise<void> {
  const child = plannotatorChildren.get(pr)
  if (!child) return
  plannotatorChildren.delete(pr)
  if (!child.started) {
    child.exit = code
    return
  }
  const run = await runFacts($)
  if (run?.pr !== pr || run.status !== 'active') return

  if (child.mode === 'fix') return settleFix($, { pr, dir, stdout, code })
  if (code !== 0) return wake($, `Plannotator result for PR ${pr}: failed — Plannotator завершился с кодом ${code}. Continue review-kit:pr-review-run, «In Plannotator» step 4.`)
  await $.fs.write(`${dir}/plannotator/decision.out`, stdout)
  try {
    const record = decisionOf(stdout)
    const posted = JSON.parse(String(await $.fs.read(`${dir}/plannotator/items.json`))) as Finding[]
    const texts = JSON.parse(String(await $.fs.read(`${dir}/texts.json`))) as Texts
    const result = reconcile(record.decision, parseMessage(record.message ?? ''), posted, texts)
    await $.fs.write(`${dir}/plannotator/texts.json`, JSON.stringify(result.texts, null, 2))
    await $.fs.write(`${dir}/plannotator/findings.json`, JSON.stringify({ findings: result.findings }, null, 2))
    await $.fs.write(`${dir}/plannotator/result.json`, JSON.stringify({ decision: record.decision, ids: result.ids }, null, 2))
    wake($, `Plannotator result for PR ${pr}: ${record.decision}, ids ${result.ids.join(',') || '—'}. Continue review-kit:pr-review-run, «In Plannotator» step 4: .review-kit/run/${pr}/plannotator/result.json`)
  } catch (error) {
    wake($, `Plannotator result for PR ${pr}: failed — ${(error as Error).message}. Continue review-kit:pr-review-run, «In Plannotator» step 4.`)
  }
}

async function settleFix($: EngineInterface, { pr, dir, stdout, code }: { pr: number; dir: string; stdout: string; code: number | null }): Promise<void> {
  const step = 'Continue review-kit:pr-fix-run, step 6'
  if (code !== 0) return wake($, `Plannotator result for PR ${pr} (fix): failed — Plannotator завершился с кодом ${code}. ${step}.`)
  await $.fs.write(`${dir}/plannotator/decision.out`, stdout)
  try {
    const { summary, feedback } = fixResult(decisionOf(stdout))
    await $.fs.write(`${dir}/plannotator/feedback.md`, `${feedback}\n`)
    await $.fs.write(`${dir}/plannotator/result.json`, JSON.stringify(summary, null, 2))
    wake($, `Plannotator result for PR ${pr} (fix): ${summary.decision}. ${step}: .review-kit/run/${pr}/plannotator/result.json`)
  } catch (error) {
    wake($, `Plannotator result for PR ${pr} (fix): failed — ${(error as Error).message}. ${step}.`)
  }
}

async function watchPlannotator($: EngineInterface, { pr, dir, stream }: { pr: number; dir: string; stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult> }): Promise<void> {
  const out: string[] = []
  try {
    for (;;) {
      const step = await stream.next()
      if (step.done) return await settlePlannotator($, { pr, dir, stdout: out.join(''), code: step.value?.code ?? null })
      if (step.value.stream === 'stdout') out.push(step.value.text)
    }
  } catch (error) {
    await settlePlannotator($, { pr, dir, stdout: '', code: null }).catch(() => undefined)
    $.ui.log(`review-kit: Plannotator: ${String(error)}`)
  }
}

async function reviewAnnotations($: EngineInterface, dir: string): Promise<string> {
  const findings = (JSON.parse(String(await $.fs.read(`${dir}/findings.json`))) as { findings: Finding[] }).findings
  const texts = JSON.parse(String(await $.fs.read(`${dir}/texts.json`))) as Texts
  await $.fs.write(`${dir}/plannotator/items.json`, JSON.stringify(findings, null, 2))
  return JSON.stringify(annotations(findings, texts))
}

async function startPlannotator($: EngineInterface, pr: number, mode: PlannotatorMode = 'review'): Promise<string> {
  const run = await runFacts($)
  if (run?.pr !== pr || run.status !== 'active') return `unavailable: нет активного прогона PR ${pr}`
  if (mode === 'review' && (run.isOwn || run.state === 'closed')) return 'unavailable: свой или закрытый PR не публикуется — только отчёт'
  if (mode === 'fix' && (!run.isOwn || run.state === 'closed')) return 'unavailable: раунд правок — только свой открытый PR'
  if (plannotatorChildren.has(pr)) return `unavailable: Plannotator по PR ${pr} уже открыт — дождитесь итога`

  const root = await projectRoot($)
  const dir = `${root}/.review-kit/run/${pr}`
  const project = sessionProject(root)
  if ((await sessionUrls($, project)).length > 0) return 'unavailable: в этом дереве уже открыта сессия Plannotator — закройте её'
  const { base } = JSON.parse(String(await $.fs.read(`${dir}/context.json`))) as { base: string }
  const body = mode === 'fix' ? '' : await reviewAnnotations($, dir)
  const argv = mode === 'fix' ? ['plannotator', 'review', '--diff-type', 'uncommitted', '--json'] : ['plannotator', 'review', '--base', base, '--diff-type', 'branch', '--json']

  const stream = $.process.spawn({ argv, cwd: root })
  const child: PlannotatorChild = {
    mode,
    stop: () => {
      plannotatorChildren.delete(pr)
      void stream.return(undefined as unknown as ProcessSpawnResult).catch(() => undefined)
    },
    started: false,
  }
  plannotatorChildren.set(pr, child)
  void watchPlannotator($, { pr, dir, stream })

  try {
    const url = await awaitSessionUrl($, { project, child })
    if (child.exit !== undefined) return `unavailable: Plannotator завершился до открытия сессии (код ${child.exit})`
    if (!url) return 'unavailable: сессия Plannotator не найдена (или их несколько)'
    if (mode === 'review') {
      const posted = await $.http.fetch(`${url}/api/external-annotations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      if (!posted.ok) return `unavailable: Plannotator не принял аннотации (${posted.status})`
    }
    if (child.exit !== undefined) return `unavailable: Plannotator завершился до открытия сессии (код ${child.exit})`

    child.started = true
    const count = mode === 'fix' ? 0 : (JSON.parse(body) as { annotations: unknown[] }).annotations.length
    return `started: Plannotator открыт — ${url}, аннотаций ${count}. Итог придёт отдельным сообщением; закончи ход и ничего не делай.`
  } finally {
    if (!child.started) child.stop()
  }
}

const TOOL_SPECS = [
  {
    name: 'review_publish',
    description: 'Publish the review of the active review-kit run: findings by ids (or "all") from findings.json with texts from texts.json (from: "plannotator" — the Plannotator result). The tool asks the user itself and publishes only on «Да». approve: true — ask to approve (only for Approved / Approved with comments). Answers "published: <url>" or "not published: …".',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' }, ids: { oneOf: [{ const: 'all' }, { type: 'array', items: { type: 'string' } }] }, approve: { type: 'boolean' }, from: { enum: ['chat', 'plannotator'] } }, required: ['pr', 'ids'] },
    isDeferred: false,
  },
  {
    name: 'replies_publish',
    description: 'Publish the replies from .review-kit/run/<N>/replies.json ({"replies": {"<item id>": "<text>"}}) into the threads of the own PR. The tool asks the user itself. Answers "published: <n>" or "not published: …".',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' } }, required: ['pr'] },
    isDeferred: false,
  },
  {
    name: 'commit_push',
    description: 'Commit the round paths of the own PR with a one-line message and push, after the user confirms in the tool\'s own dialog. Safe to repeat: a committed round is only pushed. Answers "pushed: …", "not pushed: …" (rejected — the user pulls with rebase first) or "not done: …" (a failing pre-commit hook output included).',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' }, message: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } }, required: ['pr', 'message', 'paths'] },
    isDeferred: false,
  },
  {
    name: 'review_start',
    description: 'Start the review-kit flow for a PR the user named in words, or list PRs with something to do when no number is given. Asks the user in dialogs; answers with text.',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' } } },
    isDeferred: false,
  },
  {
    name: 'review_plannotator',
    description: 'Open Plannotator for the active review-kit run and wait for the human in the background. mode review (default): posts every finding with its draft text as annotations over the PR diff; mode fix: shows the uncommitted fixes of the round, no annotations. Answers "started: …" or "unavailable: …"; the decision arrives later as a separate message.',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' }, mode: { enum: ['review', 'fix'] } }, required: ['pr'] },
    isDeferred: false,
  },
  {
    name: 'review_prepare',
    description: 'Prepare agent input for the active review-kit run: kind review | recheck | feedback | fix-check (fix-check needs paths = the round paths). Answers JSON { workflows: [{ id, scriptPath, args }], notes } — call Workflow with each scriptPath and args; or "review-kit: …" on error.',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' }, kind: { enum: ['review', 'recheck', 'feedback', 'fix-check'] }, paths: { type: 'array', items: { type: 'string' } } }, required: ['pr', 'kind'] },
    isDeferred: false,
  },
  {
    name: 'review_collect',
    description: 'Collect a finished review-kit workflow: id from review_prepare and the <output-file> of its completion notification. Answers the result JSON (findings, or triage classes) or "review-kit: …" when the review did not happen.',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' }, id: { enum: ['funnel', 'delta', 'statuses', 'triage', 'fix-check'] }, outputFile: { type: 'string' } }, required: ['pr', 'id', 'outputFile'] },
    isDeferred: false,
  },
  {
    name: 'review_tab',
    description: 'Open a review of each named PR in its own git worktree and Orca tab (/pr-review N runs there). Without Orca the first review starts in this tree. A PR that changes Claude Code settings (.claude/, .mcp.json, CLAUDE.md…) gets no tab. Answers one line per PR.',
    inputSchema: { type: 'object', properties: { prs: { type: 'array', items: { type: 'number' } } }, required: ['prs'] },
    isDeferred: false,
  },
  {
    name: 'review_finish',
    description: 'Close the active review-kit run for this PR when the review is done.',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' } }, required: ['pr'] },
    isDeferred: false,
  },
]

const COMMAND_SPECS = [
  { name: 'pr-review', description: 'Ревью PR в текущей вкладке', argumentHint: '<номер PR> | stop' },
  { name: 'pr', description: 'Что делать с PR: статусы и выбор сценария', argumentHint: '[номер PR] | cleanup' },
  { name: 'pr-recheck', description: 'Перепроверить правки в чужом PR после моего ревью', argumentHint: '<номер PR> | stop' },
  { name: 'pr-feedback', description: 'Разобрать замечания к своему PR', argumentHint: '<номер PR> | stop' },
  { name: 'pr-fix', description: 'Раунд правок своего PR', argumentHint: '<номер PR> | stop' },
]

export const register: Register = (on, options) => {
  SETTINGS.options = { ...options }
  on('session.start', async ($, e, next) => {
    for (const spec of TOOL_SPECS) {
      await $.tool.register(spec).catch(error => $.ui.log(`review-kit: инструмент ${spec.name} не зарегистрирован: ${String(error)}`))
    }
    for (const spec of COMMAND_SPECS) {
      await $.command.register(spec).catch(error => $.ui.log(`review-kit: команда /${spec.name} не зарегистрирована: ${String(error)}`))
    }
    return next(e)
  })

  for (const scenario of ['feedback', 'fix'] as const) {
    on('command.run', { command: `pr-${scenario}` }, async ($, e) => {
      const arg = String(e.args ?? '').trim()
      if (arg === 'stop') {
        const active = await activeRun($)
        if (active === undefined) return { text: 'Активного прогона нет.' }
        await finishRun($, active, 'aborted')
        return { text: `Прогон PR ${active} закрыт.` }
      }

      const pr = Number(arg)
      if (!Number.isInteger(pr) || pr < 1) return { text: `Использование: /pr-${scenario} <номер PR> | /pr-${scenario} stop` }

      try {
        return { text: await startFix($, pr, { loaded: await prContext($, pr), handoff: 'submit', scenario }) }
      } catch (error) {
        return { text: `review-kit: ${(error as Error).message}` }
      }
    })
  }

  on('command.run', { command: 'pr-recheck' }, async ($, e) => {
    const arg = String(e.args ?? '').trim()
    if (arg === 'stop') {
      const active = await activeRun($)
      if (active === undefined) return { text: 'Активного прогона нет.' }
      await finishRun($, active, 'aborted')
      return { text: `Прогон PR ${active} закрыт.` }
    }

    const pr = Number(arg)
    if (!Number.isInteger(pr) || pr < 1) return { text: 'Использование: /pr-recheck <номер PR> | /pr-recheck stop' }

    try {
      return { text: await startReview($, pr, { loaded: await prContext($, pr), handoff: 'submit', scenario: 'recheck' }) }
    } catch (error) {
      return { text: `review-kit: ${(error as Error).message}` }
    }
  })

  on('command.run', { command: 'pr-review' }, async ($, e) => {
    const arg = String(e.args ?? '').trim()
    if (arg === 'stop') {
      const active = await activeRun($)
      if (active === undefined) return { text: 'Активного прогона нет.' }
      await finishRun($, active, 'aborted')
      return { text: `Прогон PR ${active} закрыт.` }
    }

    const pr = Number(arg)
    if (!Number.isInteger(pr) || pr < 1) return { text: 'Использование: /pr-review <номер PR> | /pr-review stop' }

    try {
      return { text: await startReview($, pr, { loaded: await prContext($, pr), handoff: 'submit' }) }
    } catch (error) {
      return { text: `review-kit: ${(error as Error).message}` }
    }
  })

  on('command.run', { command: 'pr' }, async ($, e) => {
    const arg = String(e.args ?? '').trim()
    if (arg === 'cleanup') {
      const active = await activeRun($)
      if (active !== undefined) return { text: `Идёт прогон PR ${active} — уборка после него (/pr-review stop или конец ревью).` }
      try {
        return { text: (await offerCleanup($, { minBranches: 0 })) || 'Убирать нечего.' }
      } catch (error) {
        return { text: `review-kit: ${(error as Error).message}` }
      }
    }
    const pr = arg === '' ? undefined : Number(arg)
    if (pr !== undefined && (!Number.isInteger(pr) || pr < 1)) return { text: 'Использование: /pr [номер PR] | /pr cleanup' }

    try {
      return { text: await routePr($, pr, 'submit') }
    } catch (error) {
      return { text: `review-kit: ${(error as Error).message}` }
    }
  })

  on('tool.call', { tool: 'mcp__review-kit__review_start' }, async ($, e) => {
    const { pr } = e as unknown as { pr?: number }
    if (pr !== undefined && (!Number.isInteger(pr) || pr < 1)) return { result: 'review-kit: номер PR — целое больше нуля' }

    try {
      return { result: await routePr($, pr, 'return') }
    } catch (error) {
      return { result: `review-kit: ${(error as Error).message}` }
    }
  }).catch(() => ({ result: 'review-kit: review_start не выполнен' }))

  on('tool.call', { tool: 'mcp__review-kit__review_prepare' }, async ($, e) => {
    const { pr, kind, paths } = e as unknown as { pr: number; kind: PrepareKind; paths?: string[] }
    try {
      return { result: JSON.stringify(await prepare($, pr, kind, paths ?? [])) }
    } catch (error) {
      return { result: `review-kit: ${(error as Error).message}` }
    }
  }).catch(() => ({ result: 'review-kit: review_prepare не выполнен' }))

  on('tool.call', { tool: 'mcp__review-kit__review_collect' }, async ($, e) => {
    const { pr, id, outputFile } = e as unknown as { pr: number; id: WorkflowId; outputFile: string }
    try {
      return { result: await collect($, pr, id, outputFile) }
    } catch (error) {
      return { result: `review-kit: ${(error as Error).message}` }
    }
  }).catch(() => ({ result: 'review-kit: review_collect не выполнен' }))

  on('tool.call', { tool: 'mcp__review-kit__review_publish' }, async ($, e) => {
    try {
      return { result: await publishReview($, e as unknown as { pr: number; ids: string[] | 'all'; approve?: boolean; from?: 'chat' | 'plannotator' }) }
    } catch (error) {
      return { result: `review-kit: ${(error as Error).message}` }
    }
  }).catch(() => ({ result: 'review-kit: review_publish не выполнен' }))

  on('tool.call', { tool: 'mcp__review-kit__replies_publish' }, async ($, e) => {
    try {
      return { result: await publishReplies($, (e as unknown as { pr: number }).pr) }
    } catch (error) {
      return { result: `review-kit: ${(error as Error).message}` }
    }
  }).catch(() => ({ result: 'review-kit: replies_publish не выполнен' }))

  on('tool.call', { tool: 'mcp__review-kit__commit_push' }, async ($, e) => {
    try {
      return { result: await commitPush($, e as unknown as { pr: number; message: string; paths: string[] }) }
    } catch (error) {
      return { result: `review-kit: ${(error as Error).message}` }
    }
  }).catch(() => ({ result: 'review-kit: commit_push не выполнен' }))

  on('tool.call', { tool: 'mcp__review-kit__review_tab' }, async ($, e) => {
    try {
      return { result: await openTabs($, (e as unknown as { prs: number[] }).prs) }
    } catch (error) {
      return { result: `review-kit: ${(error as Error).message}` }
    }
  }).catch(() => ({ result: 'review-kit: review_tab не выполнен' }))

  on('tool.call', { tool: 'mcp__review-kit__review_finish' }, async ($, e) => {
    const { pr } = e as unknown as { pr: number }
    if ((await activeRun($)) !== pr) return { result: `not finished: нет активного прогона PR ${pr}` }

    await finishRun($, pr, 'done')
    return { result: await withCleanup($, 'finished', CLEANUP_MIN_BRANCHES_AFTER_RUN) }
  })

  on('tool.call', { tool: 'mcp__review-kit__review_plannotator' }, async ($, e) => {
    const { pr, mode } = e as unknown as { pr: number; mode?: PlannotatorMode }
    try {
      return { result: await startPlannotator($, pr, mode === 'fix' ? 'fix' : 'review') }
    } catch (error) {
      return { result: `unavailable: ${(error as Error).message}` }
    }
  }).catch(() => ({ result: 'unavailable: review_plannotator не выполнен' }))

  for (const tool of ['Bash', 'Monitor']) {
    on('tool.call', { tool }, async ($, e, next) => {
      if ((await activeRun($)) === undefined) return next(e)
      const deny = guardText(classifyBash(String((e as { command?: string }).command ?? '')))
      return deny ? { deny } : next(e)
    }).catch(($, e, next) => (next.called ? next(e) : { deny: GUARD_FAILED }))
  }

  on('agent.spawn', async ($, e, next) => {
    const role = parseRole(e.prompt)
    const pr = role ? await activeRun($) : undefined
    const started = await next(e)
    if (!role || pr === undefined || !('agentId' in started) || !started.agentId) return started

    try {
      const manifest = parseManifest(e.prompt)
      await $.state.set({ ...GATED_AGENT, id: started.agentId }, { pr, role, read: [], returns: 0, passed: false, ...(manifest ? { manifest } : {}) })
    } catch (error) {
      await gateLog($, { pr, role, manifest: parseManifest(e.prompt) }, started.agentId, { role, event: 'hook-error', error: String(error) }).catch(() => undefined)
    }
    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    const agentId = (e as { agentId?: string }).agentId
    const input = e as unknown as { file_path?: string; offset?: number; limit?: number }
    const gated = await readGatedAgent($, agentId)
    const path = input.file_path
    if (!gated || ran.isError || input.offset !== undefined || input.limit !== undefined || !path) return ran

    await changeGatedAgent($, agentId as string, agent => ({ ...agent, read: [...agent.read, path] }))
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'StructuredOutput' }, async ($, e, next) => {
    const agentId = (e as { agentId?: string }).agentId
    const gated = await readGatedAgent($, agentId)
    if (!gated || gated.passed) return next(e)
    const id = agentId as string

    const manifest = await manifestOf($, gated)
    if (manifest === undefined) {
      await changeGatedAgent($, id, agent => ({ ...agent, passed: true }))
      await gateLog($, gated, id, { role: gated.role, event: 'no-manifest' })
      return next(e)
    }

    const unread = unreadFiles(manifest, gated.read)
    if (unread.length > 0 && gated.returns < MAX_RETURNS) {
      await changeGatedAgent($, id, agent => ({ ...agent, returns: agent.returns + 1 }))
      await gateLog($, gated, id, { role: gated.role, event: 'returned', unread })
      return { deny: `review-kit: сначала прочитай целиком (Read без offset/limit):\n${unread.join('\n')}` }
    }

    await changeGatedAgent($, id, agent => ({ ...agent, passed: true }))
    await gateLog($, gated, id, { role: gated.role, event: unread.length > 0 ? 'exhausted' : 'passed', ...(unread.length > 0 ? { unread } : {}) })
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: GUARD_FAILED }))

  for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
    on('tool.call', { tool }, async ($, e, next) => {
      const run = await runFacts($)
      const input = e as { file_path?: string; notebook_path?: string }
      const path = String(input.file_path ?? input.notebook_path ?? '').replace(/^\.\//, '')
      const inRunDir = path.startsWith(`${await projectRoot($)}/.review-kit/`) || path.startsWith('.review-kit/')
      if (run?.status !== 'active' || !run.scenario || !READ_ONLY_SCENARIOS.includes(run.scenario) || inRunDir) return next(e)
      return { deny: 'review-kit: в ревью код не правится — оформи находкой' }
    }).catch(($, e, next) => (next.called ? next(e) : { deny: GUARD_FAILED }))
  }

  on('classic.SubagentStop', async ($, e, next) => {
    const gated = await readGatedAgent($, e.agent_id)
    if (gated && !gated.passed) {
      await gateLog($, gated, e.agent_id, { role: gated.role, event: 'stopped', unread: unreadFiles((await manifestOf($, gated)) ?? [], gated.read) })
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
