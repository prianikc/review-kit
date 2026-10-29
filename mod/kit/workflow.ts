import type { EngineInterface } from 'claude-code'
import { commentIds, driftOf, loadPr, type IntakeItem, type PrData, type PrSnapshot } from '../status.ts'
import { buildInput, B_SKIPPED, fileStates, lineCount, manifestText, notAttached, type TriageItem } from '../run/input.ts'
import { readRules } from '../run/rules.ts'
import { collectFindings, finishTriage, type GateRow, type ThresholdRow } from '../run/findings.ts'
import { fetchHead, reviewBase, changedFiles, gitText, reviewed, snapshot } from '../git.ts'
import { commitSource, guideText, parseTarget, prSource, type GuideSource, type GuideTarget } from '../guide.ts'
import { triageText } from '../run/overview.ts'
import { discussionOf, type Discussion, type DiscussionThread } from '../run/discussion.ts'
import { openThreads } from '../run/review.ts'
import { RUN_FILES_EXCLUDE, projectRoot, exclude, runner, readJson } from './engine.ts'
import { activeRun, runFacts, runDir, runContext } from './state.ts'
import { forge, botLogins } from './forge.ts'

export type PrepareKind = 'review' | 'feedback' | 'fix-check'

export type WorkflowId = 'funnel' | 'triage' | 'fix-check'

export interface WorkflowSpec { id: WorkflowId; scriptPath: string; args: Record<string, unknown> }

export const DISCUSSION_TRUNCATED = 'обсуждение PR обрезано по лимиту — часть комментариев агенты не видели'

export interface DiscussionFacts {
  threads: DiscussionThread[]
  questions: string[]
  truncated: boolean
}

export function discussionFacts({ threads, questions, truncated }: Discussion): DiscussionFacts {
  return { threads, questions, truncated }
}

export async function loadDiscussion($: EngineInterface, pr: number, { description = true, pull }: { description?: boolean; pull?: PrData['pull'] } = {}): Promise<Discussion> {
  const [data, bots] = await Promise.all([loadPr(await forge($), pr, pull), botLogins($)])
  return discussionOf(data, { bots, description })
}

export async function writeWorkflow($: EngineInterface, w: { pr: number; dir: string; id: WorkflowId; base: string; head: string; rulesRev: string; foreign: boolean; discussion: Discussion & { failed?: string }; items?: TriageItem[]; scope?: string }): Promise<{ spec: WorkflowSpec; notes: string[] }> {
  const run = runner($)
  const out = `${w.dir}/${w.id}`
  const sha = async (rev: string) => (await gitText(run, ['rev-parse', rev])).trim()
  const [base, head, rulesRev] = await Promise.all([sha(w.base), sha(w.head), sha(w.rulesRev)])
  const { rules, changedRules } = await readRules(run, { rev: rulesRev, base, head })
  const input = await buildInput(run, { base, head, rules, items: w.items, scope: w.scope, discussion: w.discussion.text })
  const notes = [
    ...(!w.items && rules.size === 0 ? [B_SKIPPED] : []),
    ...(w.foreign && changedRules.length ? [`PR меняет правила агентов: ${changedRules.join(', ')} — ревью шло по правилам базы`] : []),
    ...(w.discussion.truncated ? [DISCUSSION_TRUNCATED] : []),
    ...(w.discussion.failed ? [`обсуждение PR не загрузилось (${w.discussion.failed}) — агенты его не видели`] : []),
  ]
  await runner($)(['rm', '-rf', out])
  await Promise.all([...rules].map(([path, text]) => $.fs.write(`${out}/rules/${path}`, text)))
  await $.fs.write(`${out}/rules.json`, JSON.stringify(Object.fromEntries(rules)))
  await $.fs.write(`${out}/range.json`, JSON.stringify({ base, head }))
  await $.fs.write(`${out}/input.md`, input)
  await $.fs.write(`${out}/discussion.json`, JSON.stringify(discussionFacts(w.discussion)))
  const script = `${w.items ? 'triage' : 'review-funnel'}.js`
  await $.fs.write(`${out}/${script}`, String(await $.fs.read(`${$.plugin.root}/funnel/${script}`)))
  const copies = [...rules.keys()].map(path => `${out}/rules/${path}`)
  const roles = w.items ? [] : rules.size ? ['correctness', 'quality'] : ['correctness']
  for (const role of w.items ? ['triage'] : [...roles, 'refuter']) await $.fs.write(`${out}/manifest-${role}.txt`, manifestText(copies, notes))
  const rel = `.review-kit/run/${w.pr}/${w.id}`
  const args = w.items
    ? { pr: w.pr, input: `${rel}/input.md`, manifestDir: rel, ids: w.items.map(item => item.id) }
    : { pr: w.pr, input: `${rel}/input.md`, manifestDir: rel, roles }
  return { spec: { id: w.id, scriptPath: `${out}/${script}`, args }, notes }
}

export async function prepare($: EngineInterface, pr: number, kind: PrepareKind, paths: string[]): Promise<{ workflows: WorkflowSpec[]; notes: string[]; overview?: string }> {
  const { dir, context } = await runContext($, pr)
  const loaded: { data?: PrData; discussion: Discussion & { failed?: string } } = await Promise.all([loadPr(await forge($), pr), botLogins($)]).then(([data, bots]) => ({ data, discussion: discussionOf(data, { bots, description: true }) }), (error: unknown) => {
    const failed = (error as Error).message
    return { discussion: { threads: [], questions: [], truncated: false, text: `## DISCUSSION\nобсуждение не загрузилось: ${failed}`, failed } }
  })
  const { discussion } = loaded
  await $.fs.write(`${dir}/discussion.json`, JSON.stringify(discussionFacts(discussion)))
  if (kind === 'review') await $.fs.write(`${dir}/snapshot.json`, JSON.stringify({ headSha: context.headSha, commentIds: loaded.data ? commentIds(loaded.data) : null }))
  const base = { pr, dir, discussion }
  const parts: Array<{ spec: WorkflowSpec; notes: string[] }> = []
  if (kind === 'review') parts.push(await writeWorkflow($, { ...base, id: 'funnel', base: context.base, head: context.head, rulesRev: context.base, foreign: true }))
  if (kind === 'feedback') {
    const intake = JSON.parse(String(await $.fs.read(`${dir}/intake.json`))) as { items: TriageItem[] }
    parts.push(await writeWorkflow($, { ...base, id: 'triage', base: context.base, head: 'HEAD', rulesRev: 'HEAD', foreign: false, items: intake.items }))
  }
  if (kind === 'fix-check') {
    const head = await snapshot(runner($), { paths, indexFile: `${dir}/snapshot.index` })
    parts.push(await writeWorkflow($, { ...base, id: 'fix-check', base: 'HEAD', head, rulesRev: 'HEAD', foreign: false }))
  }
  if (parts.length === 0) throw new Error(`неизвестный вид подготовки ${kind}`)
  const overview = kind === 'feedback' ? await $.fs.read(`${dir}/overview.md`).then(String, () => '') : ''
  return { workflows: parts.map(part => part.spec), notes: [...new Set(parts.flatMap(part => part.notes))], ...(overview ? { overview } : {}) }
}

export async function workflowNotes($: EngineInterface, out: string): Promise<{ manifestNotes: string[]; gateRows: GateRow[] }> {
  const names = (await runner($)(['ls', '-1', out])).stdout.split('\n').filter(Boolean)
  const read = (name: string) => $.fs.read(`${out}/${name}`).then(String, () => '')
  const manifests = await Promise.all(names.filter(name => /^manifest-.*\.txt$/.test(name)).sort().map(read))
  const gates = await Promise.all(names.filter(name => /^gate-.*\.jsonl$/.test(name)).sort().map(read))
  return {
    manifestNotes: [...new Set(manifests.flatMap(text => text.split('\n')).filter(line => line.startsWith('# ')).map(line => line.slice(2)))],
    gateRows: gates.flatMap(text => text.split('\n').filter(Boolean).map(line => JSON.parse(line) as GateRow)),
  }
}

export async function collect($: EngineInterface, pr: number, id: WorkflowId, outputFile: string): Promise<string> {
  const { dir } = await runContext($, pr)
  const out = `${dir}/${id}`
  const text = String(await $.fs.read(outputFile))
  await $.fs.write(`${out}/raw.json`, text)
  const raw = JSON.parse(text) as unknown
  if (id === 'triage') {
    const source = JSON.parse(String(await $.fs.read(`${dir}/intake.json`))) as { items?: TriageItem[] }
    const items = finishTriage(raw, source.items ?? [])
    const result = JSON.stringify({ items }, null, 2)
    await $.fs.write(`${dir}/triage.json`, result)
    return `${triageText(pr, (source.items ?? []) as IntakeItem[], items)}\n\ntriage: .review-kit/run/${pr}/triage.json`
  }
  const run = runner($)
  const { base, head } = JSON.parse(String(await $.fs.read(`${out}/range.json`))) as { base: string; head: string }
  const rules = new Map(Object.entries(JSON.parse(String(await $.fs.read(`${out}/rules.json`))) as Record<string, string>))
  const changed = reviewed(await changedFiles(run, base, head))
  const states = await fileStates(run, base, head, changed)
  const lineCounts = new Map([...states].filter(([, s]) => s.text !== null).map(([path, s]) => [path, lineCount(s.text ?? '')]))
  const table = (JSON.parse(String(await $.fs.read(`${$.plugin.root}/config/funnel.json`))) as { threshold: ThresholdRow[] }).threshold
  const discussion = await readJson<DiscussionFacts>($, `${out}/discussion.json`, { threads: [], questions: [], truncated: false })
  const result = collectFindings({
    raw, changed, lineCounts, rules, skipped: notAttached(states), table, ...(await workflowNotes($, out)),
    threads: discussion.threads, repeats: id !== 'fix-check',
  })
  const json = JSON.stringify({ ...result, discussion: { ...discussion, open: openThreads(discussion.threads) } }, null, 2)
  await $.fs.write(id === 'fix-check' ? `${out}/findings.json` : `${dir}/findings.json`, json)
  return id === 'fix-check' ? json : staleMarked($, pr, dir, json)
}

export async function staleness($: EngineInterface, pr: number, dir: string): Promise<string | undefined> {
  const context = await readJson<{ headSha?: string }>($, `${dir}/context.json`, {})
  const snapshot = await readJson<PrSnapshot>($, `${dir}/snapshot.json`, { headSha: context.headSha ?? '', commentIds: null })
  if (!snapshot.headSha) return undefined
  const [data, bots] = await Promise.all([loadPr(await forge($), pr), botLogins($)])
  return driftOf(snapshot, data, [data.me, ...bots])
}

export async function staleMarked($: EngineInterface, pr: number, dir: string, text: string): Promise<string> {
  const note = await staleness($, pr, dir).then(found => found ? `PR изменился во время прогона: ${found} — отчёт устарел` : '', (error: unknown) => `свежесть PR не проверена: ${(error as Error).message}`)
  return note ? `${note}\n\n${text}` : text
}

export async function guideSource($: EngineInterface, target: GuideTarget): Promise<GuideSource> {
  const run = runner($)
  if (target.kind === 'commit') return commitSource(run, target.ref)
  const provider = await forge($)
  const pull = await provider.getPull(target.number)
  const dir = await runDir($, pull.number)
  const discussion = await loadDiscussion($, pull.number, { description: false, pull }).then(found => found.text, (error: unknown) => `## DISCUSSION\nобсуждение не загрузилось: ${(error as Error).message}`)
  const active = (await activeRun($)) === pull.number ? await readJson<{ base?: string; head?: string; baseFallback?: boolean; baseNote?: string; scenario?: string }>($, `${dir}/context.json`, {}) : {}
  if (active.base && active.head) return prSource(pull, { base: active.base, head: active.head, baseFallback: Boolean(active.baseFallback), baseNote: active.baseNote, discussion })
  const { target: head } = await fetchHead(run, { number: pull.number, headRef: pull.headRef, headSha: pull.headSha, baseRef: pull.baseRef, own: false, pullRef: provider.pullRef(pull.number) })
  return prSource(pull, { head, ...(await reviewBase(run, { final: head, baseRef: pull.baseRef })), discussion })
}

export async function prepareGuide($: EngineInterface, text: string): Promise<string> {
  const target = parseTarget(text)
  const source = await guideSource($, target)
  const path = `${await projectRoot($)}/.review-kit/guide/${source.key}.md`
  await exclude($, RUN_FILES_EXCLUDE)
  await $.fs.write(path, await guideText(runner($), source))
  const facts = await runFacts($)
  const inRun = target.kind === 'pr' && facts?.status === 'active' && facts.pr === target.number && facts.scenario === 'review'
  return `guide: ${path}\n${source.heading}${inRun ? `\nhotspots: .review-kit/run/${target.number}/hotspots.json` : ''}`
}
