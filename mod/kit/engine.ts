import type { EngineInterface } from 'claude-code'
import type { PrContext, PrData } from '../status.ts'
import { excludeFile, withExcluded, type Run } from '../git.ts'

export const CONFIRM_TEXT_LIMIT = 6000

export const CANCEL = 'Отмена'

export const CONTINUE_THERE = 'Продолжить там'

export const CLEAR = 'Очистить'

export const CONTINUE_HEAD = 'Продолжить с текущим HEAD'

export const WORKTREES_EXCLUDE = '/.claude/worktrees/'

export const RUN_FILES_EXCLUDE = '/.review-kit/'

export const TABS_FILE = '.claude/worktrees/orca-tabs.json'

export const STATUS_ARGV = ['git', 'status', '--porcelain', '-uno', '--ignore-submodules=all']

export const SUBMIT_ATTEMPTS = 5

export async function projectRoot($: EngineInterface): Promise<string> {
  const { stdout } = await runner($)(['git', 'rev-parse', '--show-toplevel'])
  return stdout.trim()
}

export type Handoff = 'submit' | 'return'

export async function exclude($: EngineInterface, line: string): Promise<void> {
  const path = await excludeFile(runner($))
  const text = withExcluded(await $.fs.read(path).then(String, () => ''), line)
  if (text !== undefined) await $.fs.write(path, text)
}

export function submitLater($: EngineInterface, text: string, attempts: number): void {
  $.clock.after(0, () => $.prompt.submit({ text }).catch(error => {
    if (attempts > 1 && /command\.run hook/.test(String(error))) return submitLater($, text, attempts - 1)
    $.ui.log(`review-kit: prompt.submit не прошёл: ${String(error)}`)
  }))
}

export type Loaded = { context: PrContext; data: PrData }

export function runner($: EngineInterface): Run {
  return async (argv, init) => $.process.run(argv, { cwd: await $.session.root(), ...init })
}

export async function readJson<T>($: EngineInterface, path: string, fallback: T): Promise<T> {
  return $.fs.read(path).then(text => JSON.parse(String(text)) as T, () => fallback)
}

export function wake($: EngineInterface, text: string): void {
  $.prompt.submit({ text }).catch(error => $.ui.log(`review-kit: prompt.submit не прошёл: ${String(error)}`))
}
