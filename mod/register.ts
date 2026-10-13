import { update, type Register, type EngineInterface, type HookStream, type ProcessSpawnChunk, type ProcessSpawnResult } from 'claude-code'
import { classifyBash, decideBash, kitScriptPaths, kitUsage, messageProblem, KIT_OK_SENTINEL, POST_OK_SENTINEL, POST_REPLIES_OK_SENTINEL, type CommitPushMark, type PublishMark } from './policy.ts'
import { accessDenial, manifestPaths, MAX_RETURNS, parseManifest, parseRole, unreadFiles, type GatedAgent } from './gate.ts'
import { ADAPTERS, createProvider, selectProvider, withTimeout, type ExplicitConfig } from './forge/index.ts'
import type { ForgeProvider } from './forge/types.ts'
import { actionableRows, contextOf, intakeItems, loadPr, priorComments, scenarioOf, type ListRow, type PrContext, type PrData } from './status.ts'
import { recheckBase } from './git.ts'

const RUN = { plugin: 'review-kit', key: 'run' } as const
const MARKS = { plugin: 'review-kit', key: 'marks' } as const
const PUBLISH_MARKS = { plugin: 'review-kit', key: 'publishMarks' } as const
const GATED_AGENT = { plugin: 'review-kit', key: 'gatedAgent' } as const
const CONFIRM_TEXT_LIMIT = 6000
const TOOL_TIMEOUT_MS = 120_000
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
const SCENARIO_LABEL = { feedback: 'замечания', review: 'ревью', recheck: 'перепроверка' } as const
const GUARD_FAILED = 'review-kit: guard failed — действие отклонено'
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

function kitScripts($: EngineInterface): string[] {
  return kitScriptPaths($.plugin.root)
}

async function projectRoot($: EngineInterface): Promise<string> {
  const { stdout } = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
  return stdout.trim()
}

async function runTool($: EngineInterface, argv: string[], timeoutMs: number = TOOL_TIMEOUT_MS): Promise<string> {
  const { exitCode, stdout, stderr } = await $.process.run(argv, { timeoutMs })
  if (exitCode !== 0) throw new Error(stderr.trim() || `${argv[1]}: код ${exitCode}`)
  return stdout
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
  await $.fs.write(`${await runDir($, pr)}/session.json`, JSON.stringify({ sessionId: await $.session.id(), status: 'active' }))
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

async function readCommitMarks($: EngineInterface): Promise<Record<number, CommitPushMark>> {
  return ((await $.state.get(MARKS)).value as Record<number, CommitPushMark> | undefined) ?? {}
}

async function readPublishMarks($: EngineInterface): Promise<Record<string, PublishMark>> {
  return ((await $.state.get(PUBLISH_MARKS)).value as Record<string, PublishMark> | undefined) ?? {}
}

function withoutPr<T>(marks: Record<string, T>, pr: number): Record<string, T> {
  return Object.fromEntries(Object.entries(marks).filter(([key]) => Number(key.split(':')[0]) !== pr))
}

function publishKey(pr: number, action: PublishMark['action']): string {
  return action === 'publish-replies' ? `${pr}:replies` : String(pr)
}

async function finishRun($: EngineInterface, pr: number, status: 'done' | 'aborted'): Promise<void> {
  plannotatorChildren.get(pr)?.stop()
  await $.state.set(RUN, { pr, status, isOwn: false, state: 'closed', head: '' })
  await update($, MARKS, marks => withoutPr(marks ?? {}, pr))
  await update($, PUBLISH_MARKS, marks => withoutPr(marks ?? {}, pr))
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

async function gatedDenial($: EngineInterface, e: { tool: string; agentId?: string }): Promise<string | undefined> {
  if (!(await readGatedAgent($, e.agentId))) return undefined
  return accessDenial({ tool: e.tool, input: e as unknown as Record<string, unknown>, root: await projectRoot($), home: (await $.env.get('HOME')) ?? '' })
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
  await runTool($, ['git', 'stash', 'push', '-m', name])
  const sha = await stashTop($)
  if (!sha || sha === before) throw new Error('stash не создан — дерево не тронуто')
  return { name, sha }
}

async function switchOrRestore($: EngineInterface, { tools, pr, context, stash }: { tools: string; pr: number; context: PrContext; stash: SavedStash | null }): Promise<{ head: string; base: string; detached: boolean; baseFallback?: boolean }> {
  const before = (await $.process.run(['git', 'rev-parse', 'HEAD'])).stdout.trim()
  try {
    const argv = ['bash', `${tools}/switch-pr`, '--number', String(pr), '--head-ref', context.headRef, '--head-sha', context.headSha, '--base-ref', context.baseRef, ...(context.isOwn ? ['--own'] : [])]
    return JSON.parse(await runTool($, argv))
  } catch (error) {
    if (!stash) throw error
    const after = (await $.process.run(['git', 'rev-parse', 'HEAD'])).stdout.trim()
    if (after !== before) throw new Error(`${(error as Error).message}; дерево уже на коммите PR; stash «${stash.name}» не применён — вернитесь (git switch -) и примените его через /pr cleanup`)
    const restored = JSON.parse(await runTool($, ['python3', `${tools}/cleanup.py`, 'stash', stash.sha, 'apply'])) as { ok: boolean; conflict?: boolean; error?: string }
    const note = restored.ok ? 'изменения возвращены из stash' : restored.conflict ? `изменения из stash «${stash.name}» ${restored.error}` : `изменения остались в stash «${stash.name}»: ${restored.error}`
    throw new Error(`${(error as Error).message}; ${note}`)
  }
}

async function prContext($: EngineInterface, pr: number): Promise<Loaded> {
  const data = await loadPr(await forge($), pr)
  return { context: contextOf(data, scenarioOf(data)), data }
}

interface CleanupList {
  branches: Array<{ name: string; reason: string; kind: string }>
  stashes: Array<{ sha: string; message: string; branch: string }>
  worktrees: ReviewWorktree[]
}

interface ReviewWorktree {
  path: string
  pr: number
  branch: string
  deleteBranch: boolean
}

interface RemovedWorktrees {
  removed: string[]
  skipped: Array<{ path: string; reason: string }>
}

interface HeldWorktree {
  path: string
  pr: number
  active: boolean
  dirty: boolean
}

function worktreeLine({ pr, path, branch, deleteBranch }: ReviewWorktree): string {
  const fate = !branch ? 'без ветки' : deleteBranch ? `ветка ${branch} удалится` : `ветка ${branch} останется`
  return `#${pr} ${path.split('/').pop()} — ${fate}`
}

async function offerWorktrees($: EngineInterface, { tool, worktrees }: { tool: string; worktrees: ReviewWorktree[] }): Promise<string | undefined> {
  const remove = `Удалить все (${worktrees.length})`
  if ((await $.ui.ask(`${WORKTREE_TITLE}\n${worktrees.map(worktreeLine).join('\n')}`, [remove, KEEP]).catch(() => KEEP)) !== remove) return undefined

  const result = JSON.parse(await runTool($, ['python3', tool, 'remove-worktrees', ...worktrees.map(w => w.path)])) as RemovedWorktrees
  const branches = worktrees.filter(w => w.deleteBranch && result.removed.includes(w.path)).map(w => w.branch)
  const deleted = branches.length ? (JSON.parse(await runTool($, ['python3', tool, 'delete-branches', ...branches])) as { deleted: string[] }).deleted : []

  const skipped = result.skipped.length ? `, пропущено: ${result.skipped.map(s => `${s.path.split('/').pop()} (${s.reason})`).join(', ')}` : ''
  return `удалено worktree: ${result.removed.length}${deleted.length ? `, их веток: ${deleted.length}` : ''}${skipped}`
}

async function releaseWorktree($: EngineInterface, { pr, headRef }: { pr: number; headRef: string }): Promise<string | undefined> {
  const tool = `${$.plugin.root}/tools/cleanup.py`
  const held = JSON.parse(await runTool($, ['python3', tool, 'holder', headRef])) as Partial<HeldWorktree>
  if (!held.path) return undefined

  const changes = held.dirty ? ' В нём есть незакоммиченные изменения — они удалятся.' : ''
  const question = held.active
    ? `Ветка ${headRef} занята: ревью PR ${held.pr} ещё идёт в ${held.path}.${changes} После очистки закройте ту вкладку.`
    : `Ветка ${headRef} занята worktree законченного ревью ${held.path}.${changes}`
  const answer = await $.ui.ask(question, held.active ? [CONTINUE_THERE, CLEAR, CANCEL] : [CLEAR, CANCEL]).catch(() => CANCEL)

  if (answer === CONTINUE_THERE) return `Ревью PR ${held.pr} продолжается в своей вкладке. Если она закрыта: cd '${held.path}' && claude --permission-mode auto "/pr ${held.pr}". Дерево здесь не тронуто.`
  if (answer !== CLEAR) return 'Отменено: дерево не тронуто.'

  const result = JSON.parse(await runTool($, ['python3', tool, 'remove-worktrees', '--confirmed', held.path])) as RemovedWorktrees
  return result.removed.length ? undefined : `review-kit: worktree ${held.path} не удалён — ${result.skipped[0]?.reason ?? 'причина неизвестна'}. PR ${pr} не начат.`
}

async function offerCleanup($: EngineInterface, { minBranches }: { minBranches: number }): Promise<string> {
  const tool = `${$.plugin.root}/tools/cleanup.py`
  const found = JSON.parse(await runTool($, ['python3', tool, 'list'])) as CleanupList
  const worktrees = found.worktrees ?? []
  const branchesDue = found.branches.length > minBranches
  const stashes = minBranches === 0 || branchesDue ? found.stashes : []
  if (worktrees.length === 0 && !branchesDue && stashes.length === 0) return ''

  const done: string[] = []
  const removed = worktrees.length ? await offerWorktrees($, { tool, worktrees }) : undefined
  if (removed) done.push(removed)

  for (const group of branchesDue ? BRANCH_GROUPS : []) {
    const branches = found.branches.filter(b => b.kind === group.kind)
    if (branches.length === 0) continue
    const remove = `Удалить все (${branches.length})`
    const list = branches.map(b => `${b.name} — ${b.reason}`).join('\n')
    if ((await $.ui.ask(`${group.title}\n${list}`, [remove, KEEP]).catch(() => KEEP)) !== remove) continue
    const result = JSON.parse(await runTool($, ['python3', tool, 'delete-branches', ...branches.map(b => b.name)])) as { deleted: string[]; skipped: Array<{ name: string }> }
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
    const result = JSON.parse(await runTool($, ['python3', tool, 'stash', stash.sha, answer === 'Удалить' ? 'drop' : 'apply'])) as { ok: boolean; conflict?: boolean; error?: string }
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

    const rows: ListRow[] = await actionableRows(await forge($))
    if (rows.length === 0) return withCleanup($, 'По открытым PR делать нечего.', 0)

    const labels = rows.map(row => `#${row.number} ${SCENARIO_LABEL[row.scenario]} — ${row.title}`)
    if (rows.length > MAX_DIALOG_OPTIONS) return `PR, по которым есть дело:\n${labels.join('\n')}\nВыберите: /pr <номер>`

    const chosen = String(await $.ui.ask('Какой PR берём?', rows.length === 1 ? [...labels, CANCEL] : labels).catch(() => ''))
    const row = rows[labels.indexOf(chosen)]
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
  const tools = `${$.plugin.root}/tools`

  const reviewing = scenario === 'review' || scenario === 'recheck'
  const model = await $.ui.ask(`Модель для ${reviewing ? 'ревью' : 'разбора замечаний'} PR ${pr}?`, ['opus', 'sonnet', 'haiku']).catch(() => undefined)
  if (!model) return 'Отменено: дерево не тронуто.'

  const dirty = (await $.process.run(STATUS_ARGV)).stdout.trim()
  const saved = dirty ? await stashOrCancel($, pr) : null
  if (saved === 'cancel') return 'Отменено: дерево не тронуто.'
  const stash = saved?.name ?? null

  const switched = await switchOrRestore($, { tools, pr, context, stash: saved })
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
  await $.fs.write(`${dir}/context.json`, JSON.stringify({ ...context, ...switched, stash, model, scenario }))
  await openRun($, { pr, context, head: switched.head, scenario })
  const next = handOff($, pr, handoff, scenario)

  if (scenario === 'feedback' || scenario === 'fix') {
    return `PR ${pr} (свой, ${scenario === 'feedback' ? 'замечания' : 'правки'}): дерево на ${context.headRef}${stash ? `, stash «${stash}»` : ''}, модель ${model}. Прогон открыт до конца раунда; закрыть вручную — /pr-${scenario} stop.${next}`
  }

  const who = context.isOwn ? 'свой — только отчёт' : context.state === 'closed' ? 'закрыт — только отчёт' : context.author
  return `PR ${pr} (${who}): дерево на ${switched.detached ? 'коммите PR' : context.headRef}${stash ? `, stash «${stash}»` : ''}, модель ${model}${switched.baseFallback ? `, база ревью — от main: ветка ${context.baseRef} на сервере удалена` : ''}. Прогон открыт до конца ревью; закрыть вручную — /pr-review stop.${next}`
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
  if (code !== 0) return wake($, `Plannotator result for PR ${pr}: failed — Plannotator завершился с кодом ${code}. Continue review-kit:pr-review-run, step 3P.4.`)
  await $.fs.write(`${dir}/plannotator/decision.out`, stdout)
  const tool = `${$.plugin.root}/tools/plannotator.py`
  const parsed = await $.process.run(['python3', tool, 'result', '--decision-file', `${dir}/plannotator/decision.out`, '--items', `${dir}/plannotator/items.json`, '--texts', `${dir}/texts.json`, '--out', `${dir}/plannotator`])
  if (parsed.exitCode !== 0) return wake($, `Plannotator result for PR ${pr}: failed — ${parsed.stderr.trim()}. Continue review-kit:pr-review-run, step 3P.4.`)

  const { decision, ids } = JSON.parse(parsed.stdout) as { decision: string; ids: string[] }
  wake($, `Plannotator result for PR ${pr}: ${decision}, ids ${ids.join(',') || '—'}. Continue review-kit:pr-review-run, step 3P.4: .review-kit/run/${pr}/plannotator/result.json`)
}

async function settleFix($: EngineInterface, { pr, dir, stdout, code }: { pr: number; dir: string; stdout: string; code: number | null }): Promise<void> {
  const step = 'Continue review-kit:pr-fix-run, step 6'
  if (code !== 0) return wake($, `Plannotator result for PR ${pr} (fix): failed — Plannotator завершился с кодом ${code}. ${step}.`)
  await $.fs.write(`${dir}/plannotator/decision.out`, stdout)
  const parsed = await $.process.run(['python3', `${$.plugin.root}/tools/plannotator.py`, 'fix-result', '--decision-file', `${dir}/plannotator/decision.out`, '--out', `${dir}/plannotator`])
  if (parsed.exitCode !== 0) return wake($, `Plannotator result for PR ${pr} (fix): failed — ${parsed.stderr.trim()}. ${step}.`)

  const { decision } = JSON.parse(parsed.stdout) as { decision: string }
  wake($, `Plannotator result for PR ${pr} (fix): ${decision}. ${step}: .review-kit/run/${pr}/plannotator/result.json`)
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
  const body = mode === 'fix' ? '' : await runTool($, ['python3', `${$.plugin.root}/tools/plannotator.py`, 'annotations', '--findings', `${dir}/lite/findings.json`, '--texts', `${dir}/texts.json`, '--out', `${dir}/plannotator`])
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

async function confirmCommitPush($: EngineInterface, input: CommitPushMark & { summary: string }): Promise<string> {
  if (!input.branch || !input.baseHead || !input.message || !Array.isArray(input.paths)) return 'not confirmed: не хватает полей branch, baseHead, message, paths'
  const problem = messageProblem(input.message)
  if (problem) return `not confirmed: ${problem}`

  const answer = await $.ui.ask(
    `Коммитим и пушим в ${input.branch} (PR ${input.pr}, baseHead ${input.baseHead.slice(0, 7)})?\n\n${input.message}\n\nФайлы:\n${input.paths.join('\n')}\n\n${input.summary}`,
    ['Да', 'Нет'],
  )
  if (answer !== 'Да') return 'not confirmed: пользователь отказал'

  const mark: CommitPushMark = { action: 'commit-push', pr: input.pr, branch: input.branch, baseHead: input.baseHead, message: input.message, paths: input.paths }
  await update($, MARKS, marks => ({ ...(marks ?? {}), [input.pr]: mark }))
  return 'confirmed'
}

async function confirmReplies($: EngineInterface, input: { pr: number; payloadPath: string; summary: string }): Promise<string> {
  const payloadText = String(await $.fs.read(`${await projectRoot($)}/${input.payloadPath}`))
  const replies = JSON.parse(payloadText) as Array<{ path: string | null; position: number | null; body: string }>
  const lines = replies.map(reply => `• ${reply.path ? `${reply.path}:${reply.position}` : 'общий'} — ${reply.body}`).join('\n\n')
  const question = `Публикуем ответы в PR ${input.pr} (${replies.length})?\n\n${lines}`.slice(0, CONFIRM_TEXT_LIMIT)
  if ((await $.ui.ask(question, ['Да', 'Нет'])) !== 'Да') return 'not confirmed: пользователь отказал'

  const mark: PublishMark = { action: 'publish-replies', pr: input.pr, payload: input.payloadPath, payloadText }
  await update($, PUBLISH_MARKS, marks => ({ ...(marks ?? {}), [publishKey(input.pr, 'publish-replies')]: mark }))
  return 'confirmed'
}

async function confirmPublish($: EngineInterface, input: { pr: number; action: string; payloadPath?: string; summary: string }): Promise<string> {
  if (!input.payloadPath) return 'not confirmed: нет payloadPath'
  const run = await runFacts($)
  if (!run || run.pr !== input.pr) return 'not confirmed: нет активного прогона этого PR'
  if (run.state === 'closed') return 'not confirmed: PR закрыт — только отчёт'
  if (input.action === 'publish-replies') return confirmReplies($, { ...input, payloadPath: input.payloadPath })
  if (run.isOwn) return 'not confirmed: свой PR не публикуется — только отчёт'

  const root = await projectRoot($)
  const payloadText = String(await $.fs.read(`${root}/${input.payloadPath}`))
  const payload = JSON.parse(payloadText) as { event: string; body: string; comments: Array<{ path: string; new_position: number; body: string }> }
  const bare = payload.event === 'APPROVED' && !payload.body.trim() && payload.comments.length === 0
  if (bare && (await $.ui.ask(`Одобрить PR ${input.pr} без комментариев?`, ['Да', 'Нет'])) !== 'Да') return 'not confirmed: пользователь отказал'
  if (!bare) {
    const inline = payload.comments.map(c => `• ${c.path}:${c.new_position} — ${c.body}`).join('\n')
    const question = `Публикуем ревью PR ${input.pr} (${payload.event})?\n\n${payload.body}\n\n${inline}`.slice(0, CONFIRM_TEXT_LIMIT)
    if ((await $.ui.ask(question, ['Да', 'Нет'])) !== 'Да') return 'not confirmed: пользователь отказал'
    if (payload.event === 'APPROVED' && (await $.ui.ask(`Одобрить PR ${input.pr}?`, ['Да', 'Нет'])) !== 'Да') {
      return 'not confirmed: одобрение отклонено — пересоберите payload без --approve'
    }
  }

  const mark: PublishMark = { action: 'publish-review', pr: input.pr, payload: input.payloadPath, payloadText }
  await update($, PUBLISH_MARKS, marks => ({ ...(marks ?? {}), [input.pr]: mark }))
  return 'confirmed'
}

const TOOL_SPECS = [
  {
    name: 'review_confirm',
    description: 'Ask the user to confirm an irreversible review-kit action: commit + push of a round (action commit-push), publishing a review (action publish-review) or publishing replies in threads (action publish-replies). Only a confirmation through this tool lets the kit scripts run, with exactly the confirmed arguments.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { enum: ['commit-push', 'publish-review', 'publish-replies'] },
        pr: { type: 'number' },
        branch: { type: 'string' },
        baseHead: { type: 'string' },
        message: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' } },
        payloadPath: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['action', 'pr', 'summary'],
  },
    isDeferred: false,
  },
  {
    name: 'review_start',
    description: 'Start the review-kit flow for a Forgejo PR the user named in words, or list PRs with something to do when no number is given. Asks the user in dialogs; answers with text.',
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
    name: 'review_finish',
    description: 'Close the active review-kit run for this PR when the review is done.',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' } }, required: ['pr'] },
    isDeferred: false,
  },
]

const COMMAND_SPECS = [
  { name: 'pr-review', description: 'Ревью PR в текущей вкладке', argumentHint: '<номер PR> | stop' },
  { name: 'pr', description: 'Что делать с PR: выбор сценария по Forgejo', argumentHint: '[номер PR] | cleanup' },
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

  on('tool.call', { tool: 'mcp__review-kit__review_confirm' }, async ($, e) => {
    const input = e as unknown as CommitPushMark & { action: string; payloadPath?: string; summary: string }
    const pr = await activeRun($)
    if (pr === undefined || pr !== input.pr) {
      return { result: `not confirmed: нет активного прогона PR ${input.pr} в этой сессии — подтверждение не записано` }
    }

    return { result: input.action === 'publish-review' || input.action === 'publish-replies' ? await confirmPublish($, input) : await confirmCommitPush($, input) }
  })

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

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const pr = await activeRun($)
    const scripts = kitScripts($)
    const classified = classifyBash({ command: String((e as { command?: string }).command ?? ''), scripts })
    if (pr !== undefined && (classified.kind === 'kit-commit-push' || classified.kind === 'kit-post-review' || classified.kind === 'kit-post-replies')) {
      return { deny: 'review-kit: скрипты набора запускаются только через Bash' }
    }

    const verdict = decideBash({ isRunActive: pr !== undefined, classified, mark: undefined, usage: kitUsage(scripts) })
    return verdict.allow ? next(e) : { deny: verdict.reason }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: GUARD_FAILED }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const denial = await gatedDenial($, e)
    if (denial) return { deny: denial }

    const pr = await activeRun($)
    const marks = await readCommitMarks($)
    const publishMarks = await readPublishMarks($)
    const mark = pr === undefined ? undefined : marks[pr]
    const scripts = kitScripts($)
    const classified = classifyBash({ command: e.command, scripts })
    const publishAction = classified.kind === 'kit-post-replies' ? 'publish-replies' : 'publish-review'
    const publishMark = pr === undefined ? undefined : publishMarks[publishKey(pr, publishAction)]

    if ((classified.kind === 'kit-post-review' || classified.kind === 'kit-post-replies') && classified.post && publishMark) {
      const current = String(await $.fs.read(`${await projectRoot($)}/${classified.post.payload}`))
      if (current !== publishMark.payloadText) return { deny: 'review-kit: payload изменён после подтверждения — подтвердите заново' }
    }

    const verdict = decideBash({ isRunActive: pr !== undefined, classified, mark, publishMark, usage: kitUsage(scripts) })
    if (!verdict.allow) return { deny: verdict.reason }
    if (verdict.consumesMark && (e as { run_in_background?: boolean }).run_in_background === true) {
      return { deny: 'review-kit: скрипт набора нельзя запускать в фоне — отметку подтверждения нечем погасить' }
    }

    const ran = await next(e)
    const stdout = String((ran.result as { stdout?: string } | undefined)?.stdout ?? '')
    if (verdict.consumesMark && pr !== undefined && classified.kind === 'kit-commit-push' && stdout.includes(KIT_OK_SENTINEL)) {
      await update($, MARKS, current => withoutPr(current ?? {}, pr))
    }
    if (verdict.consumesMark && pr !== undefined && classified.kind === 'kit-post-review' && stdout.includes(POST_OK_SENTINEL)) {
      await update($, PUBLISH_MARKS, current => Object.fromEntries(Object.entries(current ?? {}).filter(([key]) => key !== publishKey(pr, 'publish-review'))))
    }
    if (verdict.consumesMark && pr !== undefined && classified.kind === 'kit-post-replies' && stdout.includes(POST_REPLIES_OK_SENTINEL)) {
      await update($, PUBLISH_MARKS, current => Object.fromEntries(Object.entries(current ?? {}).filter(([key]) => key !== publishKey(pr, 'publish-replies'))))
    }
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : { deny: GUARD_FAILED }))

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

  on('tool.call', { tool: 'Grep' }, async ($, e, next) => {
    const denial = await gatedDenial($, e)
    return denial ? { deny: denial } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: GUARD_FAILED }))

  on('classic.SubagentStop', async ($, e, next) => {
    const gated = await readGatedAgent($, e.agent_id)
    if (gated && !gated.passed) {
      await gateLog($, gated, e.agent_id, { role: gated.role, event: 'stopped', unread: unreadFiles((await manifestOf($, gated)) ?? [], gated.read) })
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
