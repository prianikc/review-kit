import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
import { lineCount } from '../run/input.ts'
import { reviewPool, type Finding, type FindingsResult } from '../run/findings.ts'
import { changedFiles, showFile } from '../git.ts'
import { annotations, decisionOf, fixResult, hotspotAnnotations, parseMessage, reconcile, type Hotspot } from '../plannotator.ts'
import type { Texts } from '../run/review.ts'
import { SUBMIT_ATTEMPTS, projectRoot, submitLater, runner, readJson, wake } from './engine.ts'
import { runFacts, runDir } from './state.ts'
import { sessionProject, sessionUrls, awaitSessionUrl } from './tabs.ts'

export type PlannotatorMode = 'review' | 'fix'

export interface PlannotatorChild {
  stop: () => void
  mode: PlannotatorMode
  started: boolean
  exit?: number | null
  url?: string
}

export const plannotatorChildren = new Map<number, PlannotatorChild>()

export async function settlePlannotator($: EngineInterface, { pr, dir, stdout, code }: { pr: number; dir: string; stdout: string; code: number | null }): Promise<void> {
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
  if (code !== 0) return wake($, `Plannotator result for PR ${pr}: failed — Plannotator завершился с кодом ${code}. Continue review-kit:pr-review-run, «Plannotator» step 4.`)
  await $.fs.write(`${dir}/plannotator/decision.out`, stdout)
  try {
    const record = decisionOf(stdout)
    const posted = JSON.parse(String(await $.fs.read(`${dir}/plannotator/items.json`))) as Finding[]
    const texts = JSON.parse(String(await $.fs.read(`${dir}/texts.json`))) as Texts
    const result = reconcile(record.decision, parseMessage(record.message ?? ''), posted, texts)
    await $.fs.write(`${dir}/plannotator/texts.json`, JSON.stringify(result.texts, null, 2))
    await $.fs.write(`${dir}/plannotator/findings.json`, JSON.stringify({ findings: result.findings }, null, 2))
    await $.fs.write(`${dir}/plannotator/result.json`, JSON.stringify({ decision: record.decision, ids: result.ids }, null, 2))
    wake($, `Plannotator result for PR ${pr}: ${record.decision}, ids ${result.ids.join(',') || '—'}. Continue review-kit:pr-review-run, «Plannotator» step 4: .review-kit/run/${pr}/plannotator/result.json`)
  } catch (error) {
    wake($, `Plannotator result for PR ${pr}: failed — ${(error as Error).message}. Continue review-kit:pr-review-run, «Plannotator» step 4.`)
  }
}

export async function settleFix($: EngineInterface, { pr, dir, stdout, code }: { pr: number; dir: string; stdout: string; code: number | null }): Promise<void> {
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

export async function watchPlannotator($: EngineInterface, { pr, dir, stream }: { pr: number; dir: string; stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult> }): Promise<void> {
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

export async function reviewAnnotations($: EngineInterface, dir: string): Promise<string> {
  const findings = reviewPool(JSON.parse(String(await $.fs.read(`${dir}/findings.json`))) as FindingsResult)
  const texts = JSON.parse(String(await $.fs.read(`${dir}/texts.json`))) as Texts
  await $.fs.write(`${dir}/plannotator/items.json`, JSON.stringify(findings, null, 2))
  return JSON.stringify(annotations(findings, texts))
}

export async function hotspotBody($: EngineInterface, dir: string): Promise<ReturnType<typeof hotspotAnnotations>> {
  const items = (await readJson<{ items?: Hotspot[] }>($, `${dir}/hotspots.json`, {})).items ?? []
  if (items.length === 0) return { annotations: [], skipped: [] }
  const { base, head } = JSON.parse(String(await $.fs.read(`${dir}/context.json`))) as { base: string; head: string }
  const run = runner($)
  const changed = new Set(await changedFiles(run, base, head))
  const files = [...new Set(items.map(item => item.file))].filter(file => changed.has(file))
  const counts = new Map(await Promise.all(files.map(async file => [file, lineCount(await showFile(run, head, file).catch(() => ''))] as const)))
  return hotspotAnnotations(items, counts)
}

export function hotspotNote({ annotations: added, skipped }: ReturnType<typeof hotspotAnnotations>): string {
  return `узких мест гайда ${added.length}${skipped.length ? `, пропущено (не строка PR): ${skipped.join(', ')}` : ''}`
}

export async function addHotspots($: EngineInterface, { pr, dir, url }: { pr: number; dir: string; url: string }): Promise<string> {
  const spots = await hotspotBody($, dir)
  if (spots.annotations.length === 0) return `not added: узких мест гайда для PR ${pr} нет${spots.skipped.length ? ` (пропущено: ${spots.skipped.join(', ')})` : ''}`
  const posted = await $.http.fetch(`${url}/api/external-annotations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'review-kit', annotations: spots.annotations }) })
  return posted.ok ? `added: в Plannotator ${hotspotNote(spots)}` : `not added: Plannotator не принял аннотации (${posted.status})`
}

export async function viewFindings($: EngineInterface): Promise<string> {
  const run = await runFacts($)
  if (run?.pr === undefined || run.status !== 'active') return 'Идущего ревью нет — находки показываются только внутри прогона: /pr-review <номер>.'
  if ((run.scenario ?? 'review') !== 'review' || run.isOwn || run.state === 'closed') return `Прогон PR ${run.pr} — не ревью чужого открытого PR: в Plannotator открывать нечего.`
  const stored = await readJson<FindingsResult | undefined>($, `${await runDir($, run.pr)}/findings.json`, undefined)
  if (!stored) return `В ревью PR ${run.pr} пока нет находок — открывать нечего.`
  submitLater($, `Use the review-kit:pr-review-run skill for PR ${run.pr}: the user typed /pr-view — go straight to section 3 «Plannotator».`, SUBMIT_ATTEMPTS)
  return `Открываю находки PR ${run.pr} в Plannotator.`
}

export async function startPlannotator($: EngineInterface, pr: number, mode: PlannotatorMode = 'review', hotspots = false): Promise<string> {
  const run = await runFacts($)
  if (run?.pr !== pr || run.status !== 'active') return `unavailable: нет активного прогона PR ${pr}`
  if (mode === 'review' && (run.isOwn || run.state === 'closed')) return 'unavailable: свой или закрытый PR не публикуется — только отчёт'
  if (mode === 'fix' && (!run.isOwn || run.state === 'closed')) return 'unavailable: раунд правок — только свой открытый PR'
  const open = plannotatorChildren.get(pr)
  if (open?.started && open.url && open.mode === 'review' && mode === 'review' && hotspots) return addHotspots($, { pr, dir: await runDir($, pr), url: open.url })
  if (open) return `unavailable: Plannotator по PR ${pr} уже открыт — дождитесь итога`

  const root = await projectRoot($)
  const dir = `${root}/.review-kit/run/${pr}`
  const project = sessionProject(root)
  if ((await sessionUrls($, project)).length > 0) return 'unavailable: в этом дереве уже открыта сессия Plannotator — закройте её'
  const { base } = JSON.parse(String(await $.fs.read(`${dir}/context.json`))) as { base: string }
  const findingsBody = mode === 'fix' ? '' : await reviewAnnotations($, dir)
  const spots = mode === 'review' && hotspots ? await hotspotBody($, dir) : undefined
  const body = spots ? JSON.stringify({ ...JSON.parse(findingsBody), annotations: [...JSON.parse(findingsBody).annotations, ...spots.annotations] }) : findingsBody
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
    child.url = url
    const count = mode === 'fix' ? 0 : (JSON.parse(body) as { annotations: unknown[] }).annotations.length
    return `started: Plannotator открыт — ${url}, аннотаций ${count}${spots ? ` (${hotspotNote(spots)})` : ''}. Итог придёт отдельным сообщением; закончи ход и ничего не делай.`
  } finally {
    if (!child.started) child.stop()
  }
}
