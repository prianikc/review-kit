import type { PullRequest } from './forge/types.ts'
import { changedFiles, fileDiff, gitText, type Run } from './git.ts'
import { fenced, MAX_FILE_CHARS } from './run/input.ts'

const PR_TARGET = /^#?(\d{1,6})$/
const COMMIT_TARGET = /^[\w./^~@{}-]+$/
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const MAX_COMMITS = 100
const SHORT_SHA = 10
const MAX_GUIDE_CHARS = 250_000

export type GuideTarget = { kind: 'pr'; number: number } | { kind: 'commit'; ref: string }

export interface GuideSource {
  key: string
  heading: string
  url?: string
  message: string
  base: string
  head: string
  notes: string[]
  discussion?: string
}

export function parseTarget(text: string): GuideTarget {
  const target = text.trim()
  const pr = PR_TARGET.exec(target)
  if (pr && Number(pr[1]) > 0) return { kind: 'pr', number: Number(pr[1]) }
  if (!target || target.startsWith('-') || !COMMIT_TARGET.test(target)) throw new Error(`«${target}» — не номер PR и не коммит`)
  return { kind: 'commit', ref: target }
}

export function prSource(pull: PullRequest, { base, head, baseFallback, baseNote, discussion }: { base: string; head: string; baseFallback: boolean; baseNote?: string; discussion?: string }): GuideSource {
  const state = pull.merged ? 'влит' : pull.state === 'closed' ? 'закрыт' : ''
  return {
    key: `pr-${pull.number}`,
    heading: `PR ${pull.number} · ${pull.title} · ${pull.author} · ${pull.baseRef} ← ${pull.headRef}${state ? ` · ${state}` : ''}`,
    url: pull.url,
    message: (pull.body ?? '').trim(),
    base,
    head,
    notes: [...(baseFallback ? ['база взята от main: базовая ветка PR удалена — в diff могут попасть чужие коммиты'] : []), ...(baseNote ? [baseNote] : [])],
    ...(discussion ? { discussion } : {}),
  }
}

export async function commitSource(run: Run, ref: string): Promise<GuideSource> {
  const found = await run(['git', 'rev-parse', '-q', '--verify', `${ref}^{commit}`])
  if (found.exitCode !== 0) throw new Error(`коммит ${ref} не найден — проверьте id или выполните git fetch`)
  const head = found.stdout.trim()
  const parents = (await gitText(run, ['rev-list', '--parents', '-n', '1', head])).trim().split(' ').slice(1)
  const who = (await gitText(run, ['log', '-1', '--format=%an, %ad', '--date=short', head])).trim()
  const notes = [...(parents.length > 1 ? ['merge-коммит: diff от первого родителя'] : []), ...(parents.length === 0 ? ['первый коммит: diff от пустого дерева'] : [])]
  return {
    key: `commit-${head.slice(0, SHORT_SHA)}`,
    heading: `Коммит ${head.slice(0, SHORT_SHA)} · ${who}`,
    message: (await gitText(run, ['log', '-1', '--format=%B', head])).trim(),
    base: parents[0] ?? EMPTY_TREE,
    head,
    notes,
  }
}

export async function guideText(run: Run, source: GuideSource): Promise<string> {
  const { base, head } = source
  const commits = base === EMPTY_TREE ? [] : (await gitText(run, ['log', '--reverse', '--format=%h %s', `${base}..${head}`])).split('\n').filter(Boolean)
  const stat = (await gitText(run, ['diff', '--stat=160,120', '--no-color', '--no-renames', base, head])).trimEnd()
  const shown = commits.length > MAX_COMMITS ? [...commits.slice(0, MAX_COMMITS), `… и ещё ${commits.length - MAX_COMMITS}`] : commits
  const header = [
    `# ${source.heading}`,
    ...(source.url ? [source.url] : []),
    `## MESSAGE\n${source.message ? fenced(source.message) : '(пусто)'}`,
    ...(commits.length > 1 ? [`## COMMITS\n${shown.join('\n')}`] : []),
    `## STAT\n${fenced(stat || '(изменений нет)')}`,
  ].join('\n\n')
  const notes = [...source.notes]
  const diffs: string[] = []
  const budget = { left: MAX_GUIDE_CHARS - header.length - (source.discussion?.length ?? 0) }
  for (const path of await changedFiles(run, base, head)) {
    const diff = await fileDiff(run, base, head, path)
    if (diff.length > MAX_FILE_CHARS) notes.push(`${path}: diff не приложен — больше ${MAX_FILE_CHARS} символов`)
    else if (diff.length > budget.left) notes.push(`${path}: diff не приложен — общий лимит ${MAX_GUIDE_CHARS} символов`)
    else {
      diffs.push(diff)
      budget.left -= diff.length
    }
  }
  const sections = [header, ...(notes.length ? [`## NOTES\n${notes.map(note => `- ${note}`).join('\n')}`] : []), ...(source.discussion ? [source.discussion] : []), `## DIFF\n${fenced(diffs.join(''), 'diff')}`]
  return `${sections.join('\n\n')}\n`
}
