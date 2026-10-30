import type { EngineInterface } from 'claude-code'
import { manifestPaths, type GatedAgent } from '../manifest.ts'
import { projectRoot } from './engine.ts'
import { activeRun } from './state.ts'

const GATED_AGENT = { plugin: 'review-kit', key: 'gatedAgent' } as const

export const GUARD_FAILED = 'review-kit: guard failed — действие отклонено'

export async function readGatedAgent($: EngineInterface, agentId: string | undefined): Promise<GatedAgent | undefined> {
  if (agentId === undefined) return undefined
  const agent = (await $.state.get({ ...GATED_AGENT, id: agentId })).value as GatedAgent | undefined
  return agent && agent.pr === (await activeRun($)) ? agent : undefined
}

export async function gateDir($: EngineInterface, { pr, role, manifest }: { pr: number; role: unknown; manifest?: string }): Promise<string> {
  const root = await projectRoot($)
  if (manifest) return `${manifest.startsWith('/') ? '' : `${root}/`}${manifest.slice(0, manifest.lastIndexOf('/'))}`
  return `${root}/.review-kit/run/${pr}/${role === 'triage' ? 'triage' : 'funnel'}`
}

export async function gateLog($: EngineInterface, agent: { pr: number; role: unknown; manifest?: string }, agentId: string, row: Record<string, unknown>): Promise<void> {
  const path = `${await gateDir($, agent)}/gate-${agentId}.jsonl`
  const before = await $.fs.read(path).then(String, () => '')
  await $.fs.write(path, `${before}${JSON.stringify({ agentId, ...row })}\n`)
}

export async function manifestOf($: EngineInterface, agent: GatedAgent): Promise<string[] | undefined> {
  return $.fs.read(`${await gateDir($, agent)}/manifest-${agent.role}.txt`).then(text => manifestPaths(String(text)), () => undefined)
}
