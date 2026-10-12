import { simpleCommands } from './policy.ts'

export const ROLES = ['correctness', 'quality', 'refuter', 'triage'] as const
export type Role = (typeof ROLES)[number]
export const MAX_RETURNS = 3
const PROTECTED_IN_ROOT = ['.claude/rules', '.claude/skills', '.agents/skills', '.claude/ai-dev-kit', 'docs']
const PROTECTED_IN_HOME = ['.claude/skills', '.claude/plugins']
const MEMORY = /\.claude\/projects\/[^\s"']*\/memory/
const LISTING = new Set(['ls', 'wc', 'stat', 'test', '[', 'true', 'echo', 'printf', 'cd', 'mkdir', 'find'])
const GIT_LISTING = new Set(['status', 'worktree', 'rev-parse', 'fetch', 'merge-base', 'ls-files'])
const READ_VERBS = new Set(['grep', 'rg', 'cat', 'sed', 'head', 'tail', 'less', 'more', 'awk'])
const BARE_PROTECTED = new Set(['docs', '.claude', '.agents'])
const PATTERN_FLAGS = new Set(['-e', '-f', '--regexp', '--file'])
const SEARCH_VERBS = new Set(['grep', 'rg'])
const FIND_ACTIONS = ['-exec', '-execdir', '-ok', '-delete', 'xargs']
const PATCH_FLAGS = ['-p', '-u', '--patch', '--no-index']
const NAME_FLAGS = ['--name-only', '--name-status', '--stat']
const GIT_READS = new Set(['diff', 'log', 'show', 'grep', 'blame', 'cat-file'])
const CD_VERBS = new Set(['cd', 'pushd'])
const TOKEN_START = `(^|[\\s"'=:(\`])`
const PATH_END = `(/|$|[\\s"';|&\`)])`
const DENIAL = 'review-kit: правила, скиллы, доки и память открываются Read целиком — не grep/sed/cat/head/git show'

export interface GatedAgent {
  manifest?: string
  pr: number
  role: Role
  read: string[]
  returns: number
  passed: boolean
}

export function parseManifest(prompt: string): string | undefined {
  return /^Манифест: (\S+)$/m.exec(prompt)?.[1]
}

export function parseRole(prompt: string): Role | undefined {
  const match = /^review-kit-role: (\S+)$/.exec(prompt.split('\n')[0] ?? '')
  return ROLES.find(role => role === match?.[1])
}

export function manifestPaths(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
}

export function normalizePath(path: string): string {
  const parts = path.split('/').reduce<string[]>((kept, part) => {
    if (part === '..') kept.pop()
    else if (part !== '.' && part !== '') kept.push(part)
    return kept
  }, [])
  return `/${parts.join('/')}`
}

export function unreadFiles(manifest: readonly string[], read: readonly string[]): string[] {
  const done = new Set(read.map(normalizePath))
  return manifest.filter(path => !done.has(normalizePath(path)))
}

function protectedDirs(root: string, home: string): string[] {
  return [...PROTECTED_IN_ROOT.map(dir => `${root}/${dir}`), ...PROTECTED_IN_HOME.map(dir => `${home}/${dir}`)]
}

function escaped(path: string): string {
  return path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

function mentionsProtected(text: string, root: string, home: string): boolean {
  const asToken = [...PROTECTED_IN_ROOT.filter(name => name.includes('/')), ...protectedDirs(root, home), ...PROTECTED_IN_HOME.map(dir => `~/${dir}`)]
  const asSegment = PROTECTED_IN_ROOT.filter(name => !name.includes('/'))
  return MEMORY.test(text) ||
    asToken.some(name => new RegExp(`${TOKEN_START}(\\./)?${escaped(name)}${PATH_END}`).test(text)) ||
    asSegment.some(name => new RegExp(`${TOKEN_START}(${escaped(name)}/|\\./${escaped(name)}${PATH_END})`).test(text))
}

function isListing(command: string): boolean {
  const commands = simpleCommands(command)
  if (commands.length !== 1 || /[|;&<>`\n]|\$\(/.test(command)) return false

  const [verb, ...rest] = commands[0]
  if (rest.some(arg => FIND_ACTIONS.includes(arg))) return false
  if (LISTING.has(verb)) return true
  if (verb !== 'git') return false

  const sub = rest.find(arg => !arg.startsWith('-')) ?? ''
  const nameOnly = rest.some(arg => NAME_FLAGS.includes(arg)) && !rest.some(arg => PATCH_FLAGS.includes(arg) || arg.startsWith('-L'))
  return GIT_LISTING.has(sub) || ((sub === 'diff' || sub === 'log') && nameOnly)
}

function pathArgs(verb: string, args: readonly string[]): readonly string[] {
  if (!SEARCH_VERBS.has(verb) || args.some(arg => PATTERN_FLAGS.has(arg) || arg.startsWith('--regexp=') || arg.startsWith('--file='))) return args
  const pattern = args.findIndex(arg => !arg.startsWith('-'))
  return pattern < 0 ? args : [...args.slice(0, pattern), ...args.slice(pattern + 1)]
}

export function chainLinks(command: string): string[] {
  const links: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined

  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    const pair = command.slice(index, index + 2)
    if (quote) {
      if (char === quote) quote = undefined
      current += char
    } else if (char === '\\') {
      current += pair
      index++
    } else if (char === '"' || char === "'") {
      quote = char
      current += char
    } else if (pair === '&&' || pair === '||') {
      links.push(current)
      current = ''
      index++
    } else if (char === ';' || char === '\n') {
      links.push(current)
      current = ''
    } else {
      current += char
    }
  }
  links.push(current)

  return links.filter(link => link.trim())
}

function isGitRead(verb: string, args: readonly string[]): boolean {
  if (verb !== 'git') return false
  const sub = args.find(arg => !arg.startsWith('-')) ?? ''
  const nameOnly = args.some(arg => NAME_FLAGS.includes(arg)) && !args.some(arg => PATCH_FLAGS.includes(arg) || arg.startsWith('-L'))
  return GIT_READS.has(sub) && !nameOnly
}

function readsBareProtected(command: string): boolean {
  let inside = false

  for (const link of chainLinks(command)) {
    const commands = simpleCommands(link).map(([verb = '', ...args]) => ({ verb: verb.split('/').pop() ?? '', args }))
    const bareArg = ({ verb, args }: { verb: string; args: string[] }) => pathArgs(verb, args).some(arg => BARE_PROTECTED.has(arg.replace(/\/$/, '')))
    const reads = commands.some(({ verb, args }) => READ_VERBS.has(verb) || verb === 'xargs' || (verb === 'find' && args.some(arg => arg === '-exec' || arg === '-execdir')) || isGitRead(verb, args))
    const bare = commands.some(command => !CD_VERBS.has(command.verb) && bareArg(command))
    if (reads && (bare || inside)) return true
    if (commands.some(command => CD_VERBS.has(command.verb) && bareArg(command))) inside = true
  }

  return false
}

function absolute(path: string, root: string): string {
  return normalizePath(path.startsWith('/') ? path : `${root}/${path}`)
}

export function accessDenial({ tool, input, root, home }: { tool: string; input: Record<string, unknown>; root: string; home: string }): string | undefined {
  if (tool === 'Grep') {
    const path = absolute(String(input.path ?? root), root)
    const glob = String(input.glob ?? '')
    const inside = protectedDirs(root, home).some(dir => path === dir || path.startsWith(`${dir}/`)) || MEMORY.test(path)
    const markdown = /\.mdc?\b/.test(glob) || ['md', 'markdown'].includes(String(input.type ?? ''))
    return inside || markdown || mentionsProtected(glob, root, home) ? DENIAL : undefined
  }

  const command = String(input.command ?? '')
  if (tool !== 'Bash') return undefined
  if (readsBareProtected(command)) return DENIAL
  return mentionsProtected(command, root, home) && !isListing(command) ? DENIAL : undefined
}
