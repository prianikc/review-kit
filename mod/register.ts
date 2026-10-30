import { update, type Register, type EngineInterface } from 'claude-code'
import { MAX_RETURNS, parseManifest, parseRole, unreadFiles, type GatedAgent } from './manifest.ts'
import type { ExplicitVerdict } from './run/review.ts'
import { projectRoot } from './kit/engine.ts'
import { activeRun, runFacts, READ_ONLY_SCENARIOS, finishRun } from './kit/state.ts'
import { SETTINGS } from './kit/forge.ts'
import { reviewWorktrees } from './kit/worktrees.ts'
import { type PrepareKind, type WorkflowId, prepare, collect, prepareGuide } from './kit/workflow.ts'
import { publishReview, publishReplies, commitPush } from './kit/publish.ts'
import { finishReview } from './kit/finish.ts'
import { parsePrArgs, routePr, startConflict } from './kit/start.ts'
import { GUARD_FAILED, readGatedAgent, gateLog, manifestOf } from './kit/gate.ts'

const GATED_AGENT = { plugin: 'review-kit', key: 'gatedAgent' } as const

function changeGatedAgent($: EngineInterface, agentId: string, change: (agent: GatedAgent) => GatedAgent): Promise<unknown> {
  return update($, { ...GATED_AGENT, id: agentId }, value => change(value as GatedAgent))
}

const TOOL_SPECS = [
  {
    name: 'review_publish',
    description: 'Publish the review of the active review-kit run: findings by ids (or "all") — confirmed, below the bar or unconfirmed — with texts from texts.json. From chat the verdict follows the selected findings only (a blocking finding → request changes, otherwise approve; nothing selected → never request changes); verdict: "approve" | "request-changes" — the verdict the user named — overrides that, and an approval without selected findings goes out bare. The tool asks the user itself, publishing only on «Да». source: "ext/<name>" — the folder of an extension inside .review-kit/run/<N>/ with its own findings.json ({"findings"}) and texts.json ({"comments", "summary"?}); ids pick from those findings, summary becomes the review body, verdict is required; the tool still asks «Да/Нет». Refuses when the run has no agent results. Answers "published: <url> (вердикт …)" or "not published: … (вердикт …)" — «пользователь отказал» or «окно подтверждения не открылось».',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' }, ids: { oneOf: [{ const: 'all' }, { type: 'array', items: { type: 'string' } }] }, source: { type: 'string' }, verdict: { enum: ['approve', 'request-changes'] } }, required: ['pr', 'ids'] },
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
    description: 'Commit the round paths of the own PR with a one-line message and push (in a conflict run: commit the base merge, paths = the resolved conflict files), after the user confirms in the tool\'s own dialog. Safe to repeat: a committed round is only pushed. Answers "pushed: …", "not pushed: …" (rejected — the user pulls with rebase first) or "not done: …" (a failing pre-commit hook output included).',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' }, message: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } }, required: ['pr', 'message', 'paths'] },
    isDeferred: false,
  },
  {
    name: 'conflict_start',
    description: 'Start a conflict run for the own PR: switch the tree to its branch and merge the base into it. Asks the user in dialogs. Answers text ending with "conflicts:" + files to resolve, "resolved: …", "merged: …" (merge committed, not pushed), "clean: …" (no conflicts, run closed) or "not started: …".',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' } }, required: ['pr'] },
    isDeferred: false,
  },
  {
    name: 'review_start',
    description: 'Start the review-kit flow for a PR the user named in words, or list PRs with something to do when no number is given. Asks the user in dialogs; answers with text.',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' } } },
    isDeferred: false,
  },
  {
    name: 'review_prepare',
    description: 'Prepare agent input for the active review-kit run: kind review | feedback | fix-check (fix-check needs paths = the round paths). Answers JSON { workflows: [{ id, scriptPath, args }], notes, overview? } (overview — kind feedback: every comment of the PR, ready to show) — call Workflow with each scriptPath and args; or "review-kit: …" on error.',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' }, kind: { enum: ['review', 'feedback', 'fix-check'] }, paths: { type: 'array', items: { type: 'string' } } }, required: ['pr', 'kind'] },
    isDeferred: false,
  },
  {
    name: 'review_collect',
    description: 'Collect a finished review-kit workflow: id from review_prepare and the <output-file> of its completion notification. Answers the result JSON (findings); for triage — the summary ready to show and the triage.json path or "review-kit: …" when the review did not happen.',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' }, id: { enum: ['funnel', 'triage', 'fix-check'] }, outputFile: { type: 'string' } }, required: ['pr', 'id', 'outputFile'] },
    isDeferred: false,
  },
  {
    name: 'review_worktree',
    description: 'For extension skills: create a review worktree for each named PR (no prs — for every PR with something to do) and answer JSON { trees: [{ pr, path, command, auto, note? }], here: [pr], skipped: [{ pr, reason }] }. An extension opens a terminal in each path and runs command there (named prs — /pr N review; no prs — /pr N, the scenario by status); the kit itself opens nothing, and without such an extension the worktrees are useless. here — own PRs checked out in the main tree: run /pr N in this tab. A PR that changes Claude Code settings, hooks or MCP is skipped; one that changes only agent instructions gets auto: false. Unused clean worktrees are removed by the next /pr in the main tree.',
    inputSchema: { type: 'object', properties: { prs: { type: 'array', items: { type: 'number' } } } },
    isDeferred: false,
  },
  {
    name: 'guide_prepare',
    description: 'Prepare the input for a short guide to a PR or a commit: target is a PR number ("140", "#140") or a commit id/ref. Fetches the PR when needed, never switches the tree. Answers "guide: <path>" + the heading line — the file holds the PR description or commit message, commits, stat, notes and the diff; or "review-kit: …" on error.',
    inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    isDeferred: false,
  },
  {
    name: 'review_finish',
    description: 'Close the active review-kit run for this PR when the review is done. A review that ran in its own review worktree also removes that worktree — the answer then says so, and no command works in this tab afterwards.',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' } }, required: ['pr'] },
    isDeferred: false,
  },
]

const COMMAND_SPECS = [
  { name: 'pr', description: 'Список PR, сценарий для PR N или stop', argumentHint: '[номер PR [review|feedback|fix]] | stop' },
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

  on('command.run', { command: 'pr' }, async ($, e) => {
    const args = parsePrArgs(String(e.args ?? ''))
    if ('error' in args) return { text: args.error }
    if ('stop' in args) {
      const active = await activeRun($)
      if (active === undefined) return { text: 'Активного прогона нет.' }
      await finishRun($, active, 'aborted')
      return { text: `Прогон PR ${active} закрыт.` }
    }

    try {
      return { text: await routePr($, args.pr, 'submit', args.scenario) }
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
      return { result: await publishReview($, e as unknown as { pr: number; ids: string[] | 'all'; source?: string; verdict?: ExplicitVerdict }) }
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

  on('tool.call', { tool: 'mcp__review-kit__conflict_start' }, async ($, e) => {
    const { pr } = e as unknown as { pr: number }
    if (!Number.isInteger(pr) || pr < 1) return { result: 'not started: номер PR — целое больше нуля' }
    try {
      return { result: await startConflict($, pr) }
    } catch (error) {
      return { result: `review-kit: ${(error as Error).message}` }
    }
  }).catch(() => ({ result: 'review-kit: conflict_start не выполнен' }))

  on('tool.call', { tool: 'mcp__review-kit__review_worktree' }, async ($, e) => {
    try {
      return { result: JSON.stringify(await reviewWorktrees($, (e as unknown as { prs?: number[] }).prs)) }
    } catch (error) {
      return { result: `review-kit: ${(error as Error).message}` }
    }
  }).catch(() => ({ result: 'review-kit: review_worktree не выполнен' }))

  on('tool.call', { tool: 'mcp__review-kit__guide_prepare' }, async ($, e) => {
    try {
      return { result: await prepareGuide($, String((e as unknown as { target?: unknown }).target ?? '')) }
    } catch (error) {
      return { result: `review-kit: ${(error as Error).message}` }
    }
  }).catch(() => ({ result: 'review-kit: guide_prepare не выполнен' }))

  on('tool.call', { tool: 'mcp__review-kit__review_finish' }, async ($, e) => {
    const { pr } = e as unknown as { pr: number }
    return { result: await finishReview($, pr) }
  })

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
