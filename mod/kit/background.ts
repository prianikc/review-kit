import type { EngineInterface } from 'claude-code'
import { mainWorktree } from '../git.ts'
import { SUBMIT_ATTEMPTS, WORKTREES_EXCLUDE, readJson, runner, submitLater } from './engine.ts'
import { adoptRun, runDir, skillText } from './state.ts'

const MARKER_FILE = '.review-kit/background.json'
const PUBLISH_SKILL = 'pr-publish-run'
const LAUNCH_TIMEOUT_MS = 60 * 1000
const AGENTS_CHECK_PAUSE_MS = 2 * 1000
const AGENTS_CHECKS = 3
const SESSION_NAME = /^PR-(\d+)$/
const COLOR_ORDER = ['red', 'yellow', 'green']
const FINISHED_STATES = ['done', 'stopped', 'failed']
const PERMISSION_PROMPT = 'permission prompt'

export type Verdict = 'changes' | 'comments' | 'approved'

export interface ReviewResult {
  verdict: Verdict
  blocking: number
  nonBlocking: number
}

export const VERDICT_COLOR: Record<Verdict, string> = { changes: 'red', comments: 'yellow', approved: 'green' }

export interface BackgroundMarker {
  pr: number
  mainSessionId: string
}

export function verdictOf(findings: Array<{ severity: string }>): ReviewResult {
  const blocking = findings.filter(finding => finding.severity === 'blocking').length
  const nonBlocking = findings.length - blocking
  return { verdict: blocking ? 'changes' : nonBlocking ? 'comments' : 'approved', blocking, nonBlocking }
}

export async function writeResult($: EngineInterface, pr: number): Promise<ReviewResult> {
  const dir = await runDir($, pr)
  const { findings = [] } = await readJson<{ findings?: Array<{ severity: string }> }>($, `${dir}/findings.json`, {})
  const result = verdictOf(findings)
  await $.fs.write(`${dir}/result.json`, JSON.stringify(result))
  return result
}

export function markerPath(root: string): string {
  return `${root}/${MARKER_FILE}`
}

export async function readMarker($: EngineInterface, root: string): Promise<BackgroundMarker | undefined> {
  const marker = await readJson<Partial<BackgroundMarker> | null>($, markerPath(root), null).catch(() => null)
  return marker && typeof marker.pr === 'number' && typeof marker.mainSessionId === 'string' ? { pr: marker.pr, mainSessionId: marker.mainSessionId } : undefined
}

export async function afterFunnel($: EngineInterface, pr: number): Promise<void> {
  const result = await writeResult($, pr)
  if (!(await readMarker($, await $.session.root()))) return
  $.clock.after(0, () => {
    void $.command.run({ command: 'color', args: VERDICT_COLOR[result.verdict] }).catch(error => $.ui.log(`review-kit: /color не прошёл: ${String(error)}`))
  })
}

export interface AgentSession {
  id: string
  sessionId: string
  name: string
  cwd: string
  status: string | null
  waitingFor: string | null
  state: string
}

export function sessionName(pr: number): string {
  return `PR-${pr}`
}

export function parseAgents(stdout: string): AgentSession[] {
  try {
    const list = JSON.parse(stdout) as unknown
    if (!Array.isArray(list)) return []
    return list.flatMap((item: Record<string, unknown>) => {
      const text = (key: string) => (typeof item?.[key] === 'string' ? (item[key] as string) : null)
      const [id, sessionId, name, cwd] = [text('id'), text('sessionId'), text('name'), text('cwd')]
      if (item?.kind !== 'background' || !id || !sessionId || !name || !cwd) return []
      return [{ id, sessionId, name, cwd, status: text('status'), waitingFor: text('waitingFor'), state: text('state') ?? '' }]
    })
  } catch {
    return []
  }
}

export async function listAgents($: EngineInterface, all = false): Promise<AgentSession[]> {
  const { exitCode, stdout } = await $.process.run(['claude', 'agents', '--json', ...(all ? ['--all'] : [])], { timeoutMs: LAUNCH_TIMEOUT_MS })
  return exitCode === 0 ? parseAgents(stdout) : []
}

export async function launchReview($: EngineInterface, { pr, path, prompt }: { pr: number; path: string; prompt: string }): Promise<{ session: AgentSession } | { error: string }> {
  const name = sessionName(pr)
  await $.fs.write(markerPath(path), JSON.stringify({ pr, mainSessionId: await $.session.id() } satisfies BackgroundMarker))
  const launched = await $.process.run(['claude', '--bg', '-n', name, '--permission-mode', 'auto', prompt], { cwd: path, timeoutMs: LAUNCH_TIMEOUT_MS })
    .catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: String(error) }))
  if (launched.exitCode !== 0) return { error: `фоновое ревью не запустилось: ${(launched.stderr || launched.stdout).trim() || `код ${launched.exitCode}`}` }
  for (let check = 0; check < AGENTS_CHECKS; check++) {
    if (check) await $.clock.sleep(AGENTS_CHECK_PAUSE_MS)
    const session = (await listAgents($).catch(() => [])).find(agent => agent.name === name && agent.cwd === path)
    if (session) return { session }
  }
  return { error: 'фоновая сессия не появилась в claude agents' }
}

export interface ReviewButton {
  pr: number
  id: string
  sessionId: string
  color?: string
}

function isWaiting(session: AgentSession): boolean {
  return (session.status === 'waiting' || session.state === 'blocked') && session.waitingFor !== PERMISSION_PROMPT
}

function colorRank(color?: string): number {
  const rank = COLOR_ORDER.indexOf(color ?? '')
  return rank === -1 ? COLOR_ORDER.length : rank
}

export async function reviewButtons($: EngineInterface, sessions: AgentSession[]): Promise<ReviewButton[]> {
  const buttons = await Promise.all(sessions.map(async (session): Promise<ReviewButton | undefined> => {
    const match = SESSION_NAME.exec(session.name)
    if (!match || !isWaiting(session)) return undefined
    const pr = Number(match[1])
    if ((await readMarker($, session.cwd))?.pr !== pr) return undefined
    const result = await readJson<Partial<ReviewResult>>($, `${session.cwd}/.review-kit/run/${pr}/result.json`, {}).catch(() => ({}) as Partial<ReviewResult>)
    const color = result.verdict ? VERDICT_COLOR[result.verdict] : undefined
    return color ? { pr, id: session.id, sessionId: session.sessionId, color } : undefined
  }))
  return buttons.filter((button): button is ReviewButton => button !== undefined).sort((a, b) => colorRank(a.color) - colorRank(b.color) || a.pr - b.pr)
}

export async function backgroundTreesRoot($: EngineInterface): Promise<string | undefined> {
  const root = await mainWorktree(runner($))
  const found = await $.process.run(['find', `${root}${WORKTREES_EXCLUDE}`, '-mindepth', '3', '-maxdepth', '3', '-path', `*/${MARKER_FILE}`, '-print', '-quit'])
  return found.exitCode === 0 && found.stdout.trim() !== '' ? `${root}${WORKTREES_EXCLUDE}` : undefined
}

async function resumeTo($: EngineInterface, sessionId: string): Promise<string | undefined> {
  try {
    await $.command.run({ command: 'resume', args: sessionId })
  } catch (error) {
    return String(error)
  }
  return (await $.session.id()) === sessionId ? undefined : `сессия ${sessionId} не открылась`
}

export async function openReview($: EngineInterface, button: ReviewButton): Promise<BackgroundMarker | undefined> {
  const attach = `открой его: claude attach ${sessionName(button.pr)}`
  const stopped = await $.process.run(['claude', 'stop', button.id], { timeoutMs: LAUNCH_TIMEOUT_MS }).catch(() => ({ exitCode: 1 }))
  if (stopped.exitCode !== 0) return void $.ui.toast(`review-kit: не удалось остановить фоновое ревью PR ${button.pr} — ${attach}`)
  const mainSessionId = await $.session.id()
  const failed = await resumeTo($, button.sessionId)
  if (failed) return void $.ui.toast(`review-kit: не удалось открыть ревью PR ${button.pr} (${failed}) — ${attach}`)
  const back = { pr: button.pr, mainSessionId }
  await $.command.run({ command: 'rename', args: sessionName(button.pr) }).catch(error => $.ui.log(`review-kit: /rename не прошёл: ${String(error)}`))
  try {
    await adoptRun($, button.pr)
  } catch (error) {
    $.ui.toast(`review-kit: ревью PR ${button.pr} открыто, но прогон не поднят (${String(error)}) — запустите /pr ${button.pr}`)
    return back
  }
  submitLater($, skillText(button.pr, PUBLISH_SKILL), SUBMIT_ATTEMPTS)
  return back
}

export async function backToMain($: EngineInterface, marker: BackgroundMarker): Promise<boolean> {
  const failed = await resumeTo($, marker.mainSessionId)
  if (failed) $.ui.toast(`review-kit: не удалось вернуться в основную сессию (${failed}) — /resume ${marker.mainSessionId}`)
  return !failed
}

export async function dropFinishedSessions($: EngineInterface, root: string): Promise<number> {
  const finished = (await listAgents($, true)).filter(session => SESSION_NAME.test(session.name) && session.cwd.startsWith(`${root}${WORKTREES_EXCLUDE}`) && FINISHED_STATES.includes(session.state))
  const removed = await Promise.all(finished.map(async session => {
    if ((await $.process.run(['test', '-e', session.cwd])).exitCode === 0) return false
    return (await $.process.run(['claude', 'rm', session.id], { timeoutMs: LAUNCH_TIMEOUT_MS })).exitCode === 0
  }))
  return removed.filter(Boolean).length
}
