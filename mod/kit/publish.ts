import type { EngineInterface } from 'claude-code'
import type { IntakeItem } from '../status.ts'
import { reviewPool, type FindingsResult } from '../run/findings.ts'
import { commitMerge, commitRound, mergeProblem, foreignChanges, gitText, messageProblem, pushRound, roundState, unpushed } from '../git.ts'
import { APPROVABLE, buildDraft, buildReplies, chosenVerdict, parseCovered, type ExplicitVerdict, type Texts, type VerdictName } from '../run/review.ts'
import { CONFIRM_TEXT_LIMIT, runner, readJson } from './engine.ts'
import { writeContext } from './state.ts'
import { forge } from './forge.ts'
import { staleness } from './workflow.ts'

const EXTENSION_SOURCE = /^ext\/[a-z0-9-]+$/

export async function publishReview($: EngineInterface, { pr, ids, source, verdict: asked }: { pr: number; ids: string[] | 'all'; source?: string; verdict?: ExplicitVerdict }): Promise<string> {
  const { dir, context } = await writeContext($, pr)
  if (context.isOwn || context.state === 'closed') return 'not published: свой или закрытый PR не публикуется — только отчёт'
  if (source !== undefined && !EXTENSION_SOURCE.test(source)) return 'not published: source — только ext/<имя> внутри прогона'
  if (source !== undefined && !asked) return 'not published: с source нужен verdict — approve или request-changes'
  if (asked && asked !== 'approve' && asked !== 'request-changes') return `not published: неизвестный вердикт ${String(asked)} — approve или request-changes`
  if (!(await $.fs.read(`${dir}/findings.json`).then(() => true, () => false))) return 'not published: в этом прогоне нет результатов агентов (findings.json) — вердикт не из чего считать. Сначала ревью агентами: review_prepare → Workflow → review_collect'
  const from = source === undefined ? dir : `${dir}/${source}`
  const stored = await readJson<FindingsResult>($, `${from}/findings.json`, { findings: [], belowBar: [], dropped: [], unconfirmed: [], notChecked: [] })
  const findings = source === undefined ? reviewPool(stored) : stored.findings
  const texts = await readJson<Texts>($, `${from}/texts.json`, { comments: {} })
  const wanted = ids === 'all' ? findings.map(item => item.id) : ids
  const unknown = wanted.filter(id => !findings.some(item => item.id === id))
  if (unknown.length) return `not published: нет находки: ${unknown.join(', ')}`
  const selected = findings.filter(item => wanted.includes(item.id))
  const stale = await staleness($, pr, dir).then(note => ({ note }), (error: unknown) => ({ error: (error as Error).message }))
  if ('error' in stale) return `not published: свежесть PR не проверена — ${stale.error}`
  if (stale.note) return `not published: PR обновился после снимка: ${stale.note} — перезапустите ревью: /pr stop, затем /pr ${pr}`
  const provider = await forge($)
  const covered = parseCovered(await gitText(runner($), ['diff', '-U0', '--no-color', '--no-renames', context.base, context.head]))
  const content = selected.length + (source !== undefined && texts.summary?.trim() ? 1 : 0)
  const chosen = (() => {
    try {
      return { verdict: chosenVerdict({ selected, verdict: asked, content }) }
    } catch (error) {
      return { error: (error as Error).message }
    }
  })()
  if ('error' in chosen) return `not published: ${chosen.error}`
  const verdict: VerdictName = chosen.verdict
  const { draft, notes } = buildDraft({ selected, texts: source !== undefined ? texts : { comments: texts.comments }, verdict, approve: APPROVABLE.includes(verdict), covered, capabilities: provider.capabilities })
  const bare = draft.verdict === 'approve' && !draft.body.trim() && draft.comments.length === 0
  const inline = draft.comments.map(c => `• ${c.path}:${c.line} — ${c.body}`).join('\n')
  const question = bare ? `Одобрить PR ${pr} без комментариев?` : `Публикуем ревью PR ${pr} (${verdict})?\n\n${draft.body}\n\n${inline}`.slice(0, CONFIRM_TEXT_LIMIT)
  const answer = await $.ui.ask(question, ['Да', 'Нет']).then(choice => ({ choice: String(choice) }), (error: unknown) => ({ error: String(error) }))
  if ('error' in answer) return `not published: окно подтверждения не открылось — ${answer.error} (вердикт ${verdict})`
  if (answer.choice !== 'Да') return `not published: пользователь отказал (вердикт ${verdict})`
  const { url } = await provider.publishReview(pr, draft)
  return `published: ${url} (вердикт ${verdict})${notes.length ? `\n${notes.join('\n')}` : ''}`
}

export async function publishReplies($: EngineInterface, pr: number): Promise<string> {
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

export async function commitPush($: EngineInterface, { pr, message, paths }: { pr: number; message: string; paths: string[] }): Promise<string> {
  const { dir, context } = await writeContext($, pr)
  if (!context.isOwn || context.state === 'closed') return 'not done: commit и push — только свой открытый PR'
  const problem = messageProblem(message)
  if (problem) return `not done: ${problem}`
  const run = runner($)
  const branch = (await gitText(run, ['branch', '--show-current'])).trim()
  if (branch !== context.headRef) return `not done: дерево на ветке ${branch || '(detached)'}, а PR — ${context.headRef}`
  const session = await readJson<{ roundBase?: string }>($, `${dir}/session.json`, {})
  if (!session.roundBase) return 'not done: у прогона нет базы раунда — начните раунд заново (/pr <номер> fix)'
  const merging = context.scenario === 'conflict'
  const { state, roundBase } = await roundState(run, { branch, roundBase: session.roundBase, message, firstParent: merging })
  if (roundBase !== session.roundBase) await $.fs.write(`${dir}/session.json`, JSON.stringify({ ...session, roundBase }))
  if (state === 'pushed') return `pushed: коммит раунда «${message}» уже на origin`
  if (state === 'commit') {
    const problem = merging ? await mergeProblem(run, paths) : undefined
    if (problem) return `not done: ${problem}`
    const foreign = merging ? [] : await foreignChanges(run, paths)
    if (foreign.length) return `not done: изменены файлы вне списка раунда — добавьте их в paths или верните:\n${foreign.join('\n')}`
  }
  const pending = await unpushed(run, branch)
  const commitWhat = merging ? `Коммитим слияние ${context.baseRef} и пушим в ${branch} (PR ${pr})?\n\n${message}\n\nРазрешённые конфликты:` : `Коммитим и пушим в ${branch} (PR ${pr})?\n\n${message}\n\nФайлы:`
  const what = state === 'commit' ? `${commitWhat}\n${paths.join('\n')}` : `Пушим в ${branch} (PR ${pr}) коммит ${merging ? 'слияния' : 'раунда'} «${message}»?`
  const question = `${what}${pending.length ? `\n\nУйдут и неотправленные коммиты:\n${pending.join('\n')}` : ''}`.slice(0, CONFIRM_TEXT_LIMIT)
  if ((await $.ui.ask(question, ['Да', 'Нет']).catch(() => 'Нет')) !== 'Да') return 'not done: пользователь отказал'
  if (state === 'commit') {
    const committed = merging ? await commitMerge(run, { paths, message }) : await commitRound(run, { paths, message })
    if (!committed.ok) return `not done: коммита нет — ${committed.output}`
  }
  const pushed = await pushRound(run, branch)
  if (pushed.ok) return `pushed: ${(await gitText(run, ['rev-parse', '--short', 'HEAD'])).trim()} в ${branch}`
  if (pushed.rejected && merging) return `not pushed: ветка на origin ушла вперёд — коммит слияния сохранён. Пусть пользователь выполнит \`! git pull --no-rebase\`, затем review_finish и снова /pr-confl ${pr}.\n${pushed.output}`
  return pushed.rejected
    ? `not pushed: ветка на origin ушла вперёд — нужен pull/rebase. Пусть пользователь выполнит \`! git pull --rebase\` (или в своём терминале; конфликты разрешите там же), затем снова commit_push.\n${pushed.output}`
    : `not pushed: push не прошёл (коммит раунда сохранён, повтор commit_push только запушит): ${pushed.output}`
}
