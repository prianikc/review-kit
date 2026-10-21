import { binaryFiles, changedFiles, fileDiff, reviewed, showFile, treeEntries, type Run } from '../git.ts'
import { RULE_SOURCES } from './rules.ts'

export const MAX_FILE_CHARS = 60_000
export const DELETED = 'удалён'
export const MAX_INPUT_CHARS = 250_000
const MODEL_INPUT_CHARS: Record<string, number> = { opus: 500_000 }
export const B_SKIPPED = `агент B не запускался: правил Claude Code для файлов PR нет (${RULE_SOURCES})`

export interface FileState {
  text: string | null
  reason: string | null
}

export interface TriageItem {
  id: string
  path?: string | null
  position?: number | null
  line?: number | null
  author?: string
  quote?: string
  body?: string
  stale?: boolean
  disagree?: boolean
  replies?: Array<{ author: string; body: string }>
}

export function lineCount(text: string): number {
  if (text === '') return 0
  const lines = text.split(/\r\n|\r|\n/)
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

export async function fileStates(run: Run, base: string, head: string, paths?: string[]): Promise<Map<string, FileState>> {
  const [changed, types, binary] = await Promise.all([paths ?? changedFiles(run, base, head), treeEntries(run, head), binaryFiles(run, base, head)])
  const states = new Map<string, FileState>()
  for (const path of changed) {
    const type = types.get(path)
    if (type === undefined) states.set(path, { text: null, reason: DELETED })
    else if (type === 'commit') states.set(path, { text: null, reason: 'сабмодуль' })
    else if (binary.has(path)) states.set(path, { text: null, reason: 'бинарный' })
    else {
      const text = await showFile(run, head, path)
      states.set(path, text.includes('�') ? { text: null, reason: 'не UTF-8' } : { text, reason: null })
    }
  }
  return states
}

export function notAttached(states: Map<string, FileState>, max = MAX_FILE_CHARS): Map<string, string> {
  return new Map([...states].filter(([, state]) => state.reason || (state.text ?? '').length > max).map(([path, state]) => [path, state.reason ?? `больше ${max} символов`]))
}

export function fenced(text: string, lang = ''): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${lang}\n${text}\n${fence}`
}

export function itemsSection(items: TriageItem[]): string {
  const blocks = items.map(item => {
    const place = item.path ? `${item.path}:${item.position ?? item.line ?? ''}` : 'общий'
    const replies = item.replies ?? []
    const marks = [...(['stale', 'disagree'] as const).filter(name => item[name]), ...(replies.length ? ['answered'] : [])]
    const answers = replies.map(reply => `\n\nОтвет ${reply.author}:\n${reply.body}`).join('')
    return `### ${item.id} — ${place} — ${item.author ?? ''}${marks.length ? ` (${marks.join(', ')})` : ''}\n${item.quote ?? item.body ?? ''}${answers}`
  })
  return `## ITEMS\n${blocks.join('\n\n')}`
}

export function inputLimit(model?: string): number {
  return MODEL_INPUT_CHARS[model ?? ''] ?? MAX_INPUT_CHARS
}

export async function buildInput(run: Run, { base, head, rules, items, scope, model }: { base: string; head: string; rules: Map<string, string>; items?: TriageItem[]; scope?: string; model?: string }): Promise<string> {
  const rulesText = rules.size
    ? `Rule files apply to this PR. Read each whole from your manifest — the copy is \`rules/<path>\` next to this input; cite it by <path>.\n${[...rules.keys()].map(path => `=== RULE FILE: ${path} ===`).join('\n')}`
    : 'No rule files apply to this PR.'
  const inPr = scope ? new Set(await changedFiles(run, scope, head)) : undefined
  const all = (await changedFiles(run, base, head)).filter(path => !inPr || inPr.has(path))
  const changed = items ? all : reviewed(all)
  const diffs = await Promise.all(changed.map(async path => {
    const diff = await fileDiff(run, base, head, path)
    return diff.length > MAX_FILE_CHARS ? `--- ${path} (дифф не приложен: больше ${MAX_FILE_CHARS} символов)\n` : diff
  }))
  if (changed.length < all.length) diffs.push(`--- .claude/ (не ревьюится: ${all.length - changed.length} файл(ов))\n`)
  const states = await fileStates(run, base, head, changed)
  const skipped = notAttached(states)
  const files = [...states].map(([path, state]) => (skipped.has(path) ? `=== FILE: ${path} === (не приложен: ${skipped.get(path)})` : `=== FILE: ${path} ===\n${fenced(state.text ?? '')}`)).join('\n\n')
  const sections = [`## RULES\n${rulesText}`, `## DIFF\n${fenced(diffs.join(''), 'diff')}`, `## FILES\n${files}`, ...(items ? [itemsSection(items)] : [])]
  const text = `${sections.join('\n\n')}\n`
  const limit = inputLimit(model)
  if (text.length > limit) throw new Error(`вход ${text.length} символов больше лимита ${limit}${model ? ` для модели ${model}` : ''}${limit < inputLimit('opus') ? ` (у opus — ${inputLimit('opus')})` : ''}: в дельте ${changed.length} файл(ов). Ревью одним запросом не делается: разделите PR или проверьте его частями вручную`)
  return text
}

export function manifestText(paths: string[], notes: string[]): string {
  return [...paths, ...notes.map(note => `# ${note}`)].map(line => `${line}\n`).join('')
}
