import { binaryFiles, changedFiles, fileDiff, reviewed, showFile, treeEntries, type Run } from '../git.ts'

export const MAX_FILE_CHARS = 60_000
export const MAX_INPUT_CHARS = 250_000
export const B_SKIPPED = 'агент B не запускался: для его работы нужны правила и соглашения проекта (CLAUDE.md, AGENTS.md, .claude/rules, .cursor/rules, .github/copilot-instructions.md)'
const RULE_NAMES = ['CLAUDE.md', 'AGENTS.md']
const RULE_DIRS = ['.claude/rules/', '.cursor/rules/']
const RULE_FILES = ['.github/copilot-instructions.md']

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
}

export function isRulePath(path: string): boolean {
  const name = path.split('/').pop() ?? ''
  return RULE_NAMES.includes(name) || RULE_DIRS.some(dir => path.startsWith(dir)) || RULE_FILES.includes(path)
}

export function rulePaths(tree: readonly string[], changed: readonly string[]): string[] {
  const dirs = new Set([''])
  for (const file of changed) {
    const parts = file.split('/')
    for (let depth = 1; depth < parts.length; depth++) dirs.add(parts.slice(0, depth).join('/'))
  }
  const present = new Set(tree)
  const named = [...dirs].flatMap(dir => RULE_NAMES.map(name => (dir ? `${dir}/${name}` : name))).filter(path => present.has(path))
  const shared = tree.filter(path => RULE_DIRS.some(dir => path.startsWith(dir)) || RULE_FILES.includes(path))
  return [...new Set([...named, ...shared])].sort()
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
    if (type === undefined) states.set(path, { text: null, reason: 'удалён' })
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
    const marks = (['stale', 'disagree'] as const).filter(name => item[name])
    return `### ${item.id} — ${place} — ${item.author ?? ''}${marks.length ? ` (${marks.join(', ')})` : ''}\n${item.quote ?? item.body ?? ''}`
  })
  return `## ITEMS\n${blocks.join('\n\n')}`
}

export async function readRules(run: Run, { rev, base, head }: { rev: string; base: string; head: string }): Promise<{ rules: Map<string, string>; changedRules: string[] }> {
  const [tree, changed] = await Promise.all([treeEntries(run, rev), changedFiles(run, base, head)])
  const blobs = [...tree].filter(([, type]) => type === 'blob').map(([path]) => path)
  const paths = rulePaths(blobs, changed)
  const rules = new Map(await Promise.all(paths.map(async path => [path, await showFile(run, rev, path)] as const)))
  return { rules, changedRules: changed.filter(isRulePath) }
}

export async function buildInput(run: Run, { base, head, rules, items }: { base: string; head: string; rules: Map<string, string>; items?: TriageItem[] }): Promise<string> {
  const rulesText = [...rules].map(([path, text]) => `=== RULE FILE: ${path} ===\n${fenced(text)}`).join('\n\n')
  const all = await changedFiles(run, base, head)
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
  if (text.length > MAX_INPUT_CHARS) throw new Error(`вход ${text.length} символов больше лимита ${MAX_INPUT_CHARS}: ревью одним запросом не делается, нужно делить PR`)
  return text
}

export function manifestText(paths: string[], notes: string[]): string {
  return [...paths, ...notes.map(note => `# ${note}`)].map(line => `${line}\n`).join('')
}
