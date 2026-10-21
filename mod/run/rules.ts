import { changedFiles, showFile, treeEntries, type Run } from '../git.ts'

const RULE_SYSTEMS = {
  'claude-code': { names: ['CLAUDE.md'], files: ['.claude/CLAUDE.md'], dirs: ['.claude/rules/'] },
} as const
const SYSTEM = RULE_SYSTEMS['claude-code']
const IMPORT_DEPTH = 5
const IMPORT = /(?:^|\s)@([^\s`]+)/g
const TRAILING = /[.,;:!?)\]}"']+$/
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const FENCE = /^\s*(```|~~~)/

export const RULE_SOURCES = 'CLAUDE.md, .claude/CLAUDE.md, .claude/rules/ и файлы, подключённые из них через @'

export function isRulePath(path: string): boolean {
  const name = path.split('/').pop() ?? ''
  return (SYSTEM.names as readonly string[]).includes(name) || (SYSTEM.files as readonly string[]).includes(path) || SYSTEM.dirs.some(dir => path.startsWith(dir))
}

export function rulePaths(tree: readonly string[], changed: readonly string[]): string[] {
  const dirs = new Set([''])
  for (const file of changed) {
    const parts = file.split('/')
    for (let depth = 1; depth < parts.length; depth++) dirs.add(parts.slice(0, depth).join('/'))
  }
  const present = new Set(tree)
  const named = [...dirs].flatMap(dir => SYSTEM.names.map(name => (dir ? `${dir}/${name}` : name))).filter(path => present.has(path))
  const shared = tree.filter(path => (SYSTEM.files as readonly string[]).includes(path) || SYSTEM.dirs.some(dir => path.startsWith(dir)))
  return [...new Set([...named, ...shared])].sort()
}

function unquote(text: string): string {
  return text.trim().replace(/^(["'])(.*)\1$/, '$2')
}

export function rulePatterns(text: string): string[] | null {
  const front = FRONTMATTER.exec(text)?.[1]
  if (!front) return null
  const lines = front.split(/\r?\n/)
  const at = lines.findIndex(line => /^paths\s*:/.test(line))
  if (at < 0) return null
  const inline = lines[at].replace(/^paths\s*:/, '').trim()
  if (inline.startsWith('[')) return inline.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean)
  if (inline) return [unquote(inline)]
  const items: string[] = []
  for (const line of lines.slice(at + 1)) {
    const item = /^\s*-\s*(.+)$/.exec(line)
    if (!item) break
    items.push(unquote(item[1]))
  }
  return items.filter(Boolean)
}

export function globMatch(pattern: string, path: string): boolean {
  const source = pattern.replace(/^\.\//, '').split(/(\*\*\/|\*\*|\*|\?|\{[^}]*\})/).map(part => {
    if (part === '**/') return '(?:.*/)?'
    if (part === '**') return '.*'
    if (part === '*') return '[^/]*'
    if (part === '?') return '[^/]'
    if (/^\{[^}]*\}$/.test(part)) return `(?:${part.slice(1, -1).split(',').map(alt => alt.replace(/[.+^${}()|[\]\\*?]/g, '\\$&')).join('|')})`
    return part.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }).join('')
  return new RegExp(`^${source}$`).test(path)
}

export function appliesTo(text: string, changed: readonly string[]): boolean {
  const patterns = rulePatterns(text)
  return patterns === null || patterns.length === 0 || changed.some(file => patterns.some(pattern => globMatch(pattern, file)))
}

function normalize(path: string): string | null {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') { if (!parts.pop()) return null }
    else if (part !== '.' && part !== '') parts.push(part)
  }
  return parts.join('/')
}

export function importsOf(text: string, from: string): string[] {
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
  const found: string[] = []
  const state = { fence: false }
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) { state.fence = !state.fence; continue }
    if (state.fence) continue
    const plain = line.replace(/`[^`]*`/g, ' ')
    for (const match of plain.matchAll(IMPORT)) {
      const raw = match[1].replace(TRAILING, '')
      if (!raw || raw.startsWith('~') || raw.startsWith('/')) continue
      const path = normalize(dir ? `${dir}/${raw}` : raw)
      if (path) found.push(path)
    }
  }
  return [...new Set(found)]
}

export async function readRules(run: Run, { rev, base, head }: { rev: string; base: string; head: string }): Promise<{ rules: Map<string, string>; changedRules: string[] }> {
  const [tree, changed] = await Promise.all([treeEntries(run, rev), changedFiles(run, base, head)])
  const blobs = new Set([...tree].filter(([, type]) => type === 'blob').map(([path]) => path))
  const rules = new Map<string, string>()
  for (const path of rulePaths([...blobs], changed)) {
    const text = await showFile(run, rev, path)
    if (!SYSTEM.dirs.some(dir => path.startsWith(dir)) || appliesTo(text, changed)) rules.set(path, text)
  }
  let frontier = [...rules]
  for (let depth = 0; depth < IMPORT_DEPTH && frontier.length; depth++) {
    const next: Array<[string, string]> = []
    for (const [from, text] of frontier) {
      for (const path of importsOf(text, from).filter(path => blobs.has(path) && !rules.has(path))) {
        const imported = await showFile(run, rev, path)
        rules.set(path, imported)
        next.push([path, imported])
      }
    }
    frontier = next
  }
  return { rules: new Map([...rules].sort(([a], [b]) => a.localeCompare(b))), changedRules: changed.filter(path => isRulePath(path) || rules.has(path)) }
}
