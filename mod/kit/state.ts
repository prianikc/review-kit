import type { EngineInterface } from 'claude-code'
import type { PrContext } from '../status.ts'
import type { IsActive } from '../git.ts'
import { RUN_FILES_EXCLUDE, SUBMIT_ATTEMPTS, projectRoot, exclude, submitLater, runner, readJson, type Handoff } from './engine.ts'

const RUN = { plugin: 'review-kit', key: 'run' } as const


export const ABANDONED_AFTER_MIN = 1440

export async function activeRun($: EngineInterface): Promise<number | undefined> {
  const { value } = await $.state.get(RUN)
  const run = value as { pr: number; status: string } | undefined
  return run?.status === 'active' ? run.pr : undefined
}

export interface RunFacts {
  pr: number | undefined
  status: string
  isOwn: boolean
  state: string
  head: string
  scenario?: RunScenario
}

export async function runFacts($: EngineInterface): Promise<RunFacts | undefined> {
  return (await $.state.get(RUN)).value as RunFacts | undefined
}

export async function runDir($: EngineInterface, pr: number): Promise<string> {
  return `${await projectRoot($)}/.review-kit/run/${pr}`
}

export async function openRun($: EngineInterface, { pr, context, head, scenario }: { pr: number; context: PrContext; head: string; scenario: RunScenario }): Promise<void> {
  const own = scenario === 'feedback' || scenario === 'fix' || scenario === 'conflict'
  await exclude($, RUN_FILES_EXCLUDE)
  const path = `${await runDir($, pr)}/session.json`
  const kept = (await readJson<{ roundBase?: string }>($, path, {})).roundBase
  await $.fs.write(path, JSON.stringify({ sessionId: await $.session.id(), status: 'active', ...(own ? { roundBase: kept ?? head } : {}) }))
  await $.state.set(RUN, { pr, status: 'active', isOwn: context.isOwn, state: context.state, head, scenario })
}

export async function deleteRunDir($: EngineInterface, pr: number): Promise<void> {
  if (Number.isInteger(pr) && pr > 0) await runner($)(['rm', '-rf', await runDir($, pr)])
}

export async function foreignRun($: EngineInterface, pr: number): Promise<boolean> {
  const text = await $.fs.read(`${await runDir($, pr)}/session.json`).then(String, () => '')
  if (!text) return false
  try {
    const session = JSON.parse(text) as { sessionId: string; status: string }
    return session.status === 'active' && session.sessionId !== (await $.session.id())
  } catch {
    return true
  }
}

export type RunScenario = 'review' | 'feedback' | 'fix' | 'conflict'

export const READ_ONLY_SCENARIOS: readonly RunScenario[] = ['review']

export const SKILL_OF: Record<RunScenario, string> = { review: 'pr-review-run', feedback: 'pr-feedback-run', fix: 'pr-fix-run', conflict: 'pr-confl' }

export function handOff($: EngineInterface, pr: number, handoff: Handoff, scenario: RunScenario = 'review'): string {
  const text = `Use the review-kit:${SKILL_OF[scenario]} skill for PR ${pr}; context: .review-kit/run/${pr}/context.json`
  if (handoff === 'return') return ` ${text}`

  submitLater($, text, SUBMIT_ATTEMPTS)
  return ''
}

export function parseSaved(text: string): { head?: string; headRef?: string; scenario?: string } | undefined {
  try {
    return JSON.parse(text) as { head?: string; headRef?: string; scenario?: string }
  } catch {
    return undefined
  }
}

export async function finishRun($: EngineInterface, pr: number, status: 'done' | 'aborted'): Promise<void> {
  await $.state.set(RUN, { pr, status, isOwn: false, state: 'closed', head: '' })
  await deleteRunDir($, pr)
}

export function isLive($: EngineInterface): IsActive {
  return async (path, pr) => (await isActive($)(path, pr)) && (await runner($)(['find', `${path}/.review-kit/run/${pr}/session.json`, '-mmin', `-${ABANDONED_AFTER_MIN}`])).stdout.trim() !== ''
}

export async function runContext($: EngineInterface, pr: number): Promise<{ dir: string; context: { head: string; headSha: string; base: string } }> {
  if ((await activeRun($)) !== pr) throw new Error(`нет активного прогона PR ${pr}`)
  const dir = await runDir($, pr)
  return { dir, context: JSON.parse(String(await $.fs.read(`${dir}/context.json`))) }
}

export function isActive($: EngineInterface): IsActive {
  return (path, pr) => $.fs.read(`${path}/.review-kit/run/${pr}/session.json`).then(text => {
    try {
      return (JSON.parse(String(text)) as { status?: string }).status === 'active'
    } catch {
      return true
    }
  }, () => false)
}

export async function writeContext($: EngineInterface, pr: number): Promise<{ dir: string; context: PrContext & { head: string; base: string } }> {
  if ((await activeRun($)) !== pr) throw new Error(`нет активного прогона PR ${pr} в этой сессии`)
  const dir = await runDir($, pr)
  return { dir, context: JSON.parse(String(await $.fs.read(`${dir}/context.json`))) }
}
