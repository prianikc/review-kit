import type { EngineInterface } from 'claude-code'
import { ACTIONABLE, placeAll, pullRows, splitHere } from '../status.ts'
import { createReviewWorktree, shellQuote, gitText, mainBranch } from '../git.ts'
import { createdHandle, previewHandles } from '../orca.ts'
import { WORKTREES_EXCLUDE, TABS_FILE, SUBMIT_ATTEMPTS, exclude, submitLater, runner, readJson } from './engine.ts'
import { activeRun, isActive } from './state.ts'
import { forge } from './forge.ts'
import type { PlannotatorChild } from './plannotator.ts'

export const ORCA_DEFAULT = 'orca.exe'

export const SESSION_POLLS = 20

export const SESSION_POLL_MS = 500

export async function mainRoot($: EngineInterface): Promise<string> {
  return (await gitText(runner($), ['worktree', 'list', '--porcelain'])).split('\n')[0].slice('worktree '.length)
}

export async function rememberTab($: EngineInterface, root: string, path: string, handle: string): Promise<void> {
  const file = `${root}/${TABS_FILE}`
  const tabs = await readJson<Record<string, string[]>>($, file, {})
  await $.fs.write(file, JSON.stringify({ ...tabs, [path]: [...new Set([...(tabs[path] ?? []), handle])] }, null, 2))
}

export async function closeTabs($: EngineInterface, paths: string[]): Promise<number> {
  const orca = paths.length ? await orcaBin($) : undefined
  if (!orca) return 0
  const file = `${await mainRoot($)}/${TABS_FILE}`
  const tabs = await readJson<Record<string, string[]>>($, file, {})
  const list = (await runner($)([orca, 'terminal', 'list', '--json']).catch(() => undefined))?.stdout ?? ''
  let closed = 0
  for (const path of paths) {
    for (const handle of new Set([...(tabs[path] ?? []), ...previewHandles(list, path)])) {
      if ((await runner($)([orca, 'terminal', 'close', '--terminal', handle, '--tab', '--json']).catch(() => undefined))?.exitCode === 0) closed++
    }
    delete tabs[path]
  }
  await $.fs.write(file, JSON.stringify(tabs, null, 2)).catch(() => undefined)
  return closed
}

export async function orcaBin($: EngineInterface): Promise<string | undefined> {
  const orca = (await $.env.get('ORCA_BIN')) ?? ORCA_DEFAULT
  return (await runner($)([orca, '--version']).then(result => result.exitCode === 0, () => false)) ? orca : undefined
}

export async function reviewTabs($: EngineInterface, prs: number[]): Promise<string> {
  const orca = await orcaBin($)
  if (!orca) {
    submitLater($, `/pr-review ${prs[0]}`, SUBMIT_ATTEMPTS)
    return `Orca не найдена — ревью PR ${prs[0]} запускаю в текущем дереве${prs.length > 1 ? `; остальные (${prs.slice(1).join(', ')}) — потом: /pr-review <номер>` : ''}`
  }
  const { lines, here } = await openTabs($, prs, { orca, command: '/pr-review', title: () => 'review' })
  if (here.length) {
    lines.push(`Вкладку Orca открыть не удалось — ревью PR ${here[0]} запускаю в текущем дереве${here.length > 1 ? `; остальные (${here.slice(1).join(', ')}) — потом: /pr-review <номер>` : ''}. Неиспользованные worktree уберутся при следующем /pr`)
    submitLater($, `/pr-review ${here[0]}`, SUBMIT_ATTEMPTS)
  }
  return lines.join('\n')
}

export async function openAll($: EngineInterface): Promise<string> {
  const { rows, truncated } = await pullRows(await forge($))
  const actionable = rows.filter(row => ACTIONABLE.includes(row.scenario))
  if (actionable.length === 0) return 'PR, по которым есть дело, нет.'
  const orca = await orcaBin($)
  const { tabs, here } = placeAll(actionable, { mainBranch: await mainBranch(runner($)), hasOrca: orca !== undefined })
  const scenario = (number: number) => actionable.find(row => row.number === number)?.scenario ?? 'review'
  const opened = orca && tabs.length ? await openTabs($, tabs, { orca, command: '/pr', title: scenario }) : { lines: [], here: [] }
  const lines = [...opened.lines]
  const active = await activeRun($)
  const { start, later } = splitHere([...here, ...opened.here], active !== undefined)
  if (!orca) lines.push('Orca не найдена — вкладки не открываю, PR веду в текущем дереве по одному')
  if (start !== undefined) {
    lines.push(`PR ${start}: запускаю здесь`)
    submitLater($, `/pr ${start}`, SUBMIT_ATTEMPTS)
  }
  if (later.length) lines.push(`${active !== undefined ? `Идёт прогон PR ${active} — здесь ничего не запускаю. ` : ''}Потом здесь: ${later.map(number => `/pr ${number}`).join(', ')}`)
  if (truncated) lines.push('Прочитано 50 открытых PR — это предел одного запроса; остальные — /pr <номер>')
  return lines.join('\n')
}

export async function openTabs($: EngineInterface, prs: number[], { orca, command: slash, title }: { orca: string; command: string; title: (number: number) => string }): Promise<{ lines: string[]; here: number[] }> {
  const run = runner($)
  const provider = await forge($)
  const root = (await gitText(run, ['worktree', 'list', '--porcelain'])).split('\n')[0].slice('worktree '.length)
  await exclude($, WORKTREES_EXCLUDE)
  const lines: string[] = []
  const here: number[] = []
  for (const number of prs) {
    const pull = await provider.getPull(number)
    if (pull.state === 'closed') { lines.push(`PR ${number} закрыт — вкладку не открываю`); continue }
    const tree = await createReviewWorktree(run, { root, number, headRef: pull.headRef, headSha: pull.headSha, baseRef: pull.baseRef, pullRef: provider.pullRef(number), isActive: isActive($) })
      .catch((error: Error) => ({ error: error.message }))
    if ('error' in tree) { lines.push(`PR ${number}: ${tree.error}`); continue }
    if (tree.executable.length) { lines.push(`PR ${number} меняет настройки Claude Code (${tree.executable.join(', ')}) — вкладку с новой сессией не открываю: там хуки и MCP из PR сработали бы. Здесь: ${slash} ${number} — мод спросит перед переключением дерева`); continue }
    const auto = tree.instructions.length === 0
    const command = `cd ${shellQuote(tree.path)} && claude ${auto ? '--permission-mode auto ' : ''}${shellQuote(`${slash} ${number}`)}`
    const created = await runner($)([orca, 'terminal', 'create', '--worktree', `path:${root}`, '--title', `${title(number)} #${number}`, '--focus', '--json', '--command', command]).catch(() => undefined)
    const opened = created?.exitCode === 0
    const handle = opened ? createdHandle(created.stdout) : undefined
    if (handle) await rememberTab($, root, tree.path, handle).catch(() => undefined)
    if (opened) lines.push(`PR ${number}: вкладка открыта (${tree.created ? 'новый' : 'прежний'} worktree ${tree.path})${auto ? '' : ` без режима auto: PR меняет инструкции агенту (${tree.instructions.join(', ')}) — каждая команда спросит разрешение`}`)
    else here.push(number)
  }
  return { lines, here }
}

export function sessionProject(root: string): string {
  return (root.split('/').pop() ?? '').toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-')
}

export async function sessionUrls($: EngineInterface, project: string): Promise<string[]> {
  const { stdout, stderr } = await runner($)(['plannotator', 'sessions'])
  return `${stdout}\n${stderr}`.split('\n').map(line => line.trim().split(/\s+/)).filter(cols => cols[1] === 'review' && cols[2] === project).map(cols => cols[3])
}

export async function awaitSessionUrl($: EngineInterface, { project, child }: { project: string; child: PlannotatorChild }): Promise<string | undefined> {
  for (let poll = 0; poll < SESSION_POLLS && child.exit === undefined; poll++) {
    const urls = await sessionUrls($, project)
    if (urls.length > 1) return undefined
    if (urls.length === 1) return urls[0]
    await $.clock.sleep(SESSION_POLL_MS)
  }
  return undefined
}
