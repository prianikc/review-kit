export type BashKind = 'raw-commit' | 'raw-push' | 'raw-destructive' | 'raw-write' | 'other'

const SEVERITY: readonly BashKind[] = ['raw-destructive', 'raw-push', 'raw-commit', 'raw-write', 'other']
const COMMAND_PREFIXES = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'env', 'xargs', '$'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
const READ_METHODS = new Set(['GET', 'HEAD'])
const COMMIT_COMMANDS = new Set(['commit', 'review-kit:commit'])
const COMMIT_ORIGINS = new Set(['composer', 'bridge'])
const SESSION_FILES_TITLE = '## Session files (recorded by review-kit)'
const GUARDED: Record<Exclude<BashKind, 'other'>, string> = {
  'raw-commit': 'git commit', 'raw-push': 'git push', 'raw-destructive': 'разрушающая git-команда (--force, --amend, rebase, pull, reset --hard, branch -D, stash drop…)', 'raw-write': 'запись по сети через curl/wget',
}

function worstKind(kinds: readonly BashKind[]): BashKind {
  return SEVERITY.find(kind => kinds.includes(kind)) ?? 'other'
}


export function simpleCommands(command: string): string[][] {
  const commands: string[][] = []
  let tokens: string[] = []
  let token: string | undefined
  let quote: '"' | "'" | undefined

  const endToken = () => {
    if (token !== undefined) tokens.push(token)
    token = undefined
  }
  const endCommand = () => {
    endToken()
    if (tokens.length > 0) commands.push(tokens)
    tokens = []
  }

  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined
      else token = (token ?? '') + char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      token = token ?? ''
      continue
    }
    if (char === ' ' || char === '\t') endToken()
    else if (';&|\n()`'.includes(char)) endCommand()
    else token = (token ?? '') + char
  }
  endCommand()

  return commands
}

function commandKinds(tokens: readonly string[]): BashKind[] {
  let index = 0
  while (index < tokens.length && (/^\w+=/.test(tokens[index]) || COMMAND_PREFIXES.has(tokens[index]))) index++

  const name = (tokens[index] ?? '').split('/').pop() ?? ''
  const args = tokens.slice(index + 1)

  if (SHELLS.has(name) && args[0] === '-c' && args[1]) return simpleCommands(args[1]).flatMap(commandKinds)
  if (name === 'eval') return simpleCommands(args.join(' ')).flatMap(commandKinds)
  if (name === 'git') return [classifyGit(args)]
  if (name === 'curl') return [isCurlWrite(args) ? 'raw-write' : 'other']
  if (name === 'wget') return [isWgetWrite(args) ? 'raw-write' : 'other']

  return ['other']
}

function classifyGit(args: readonly string[]): BashKind {
  let index = 0
  while (index < args.length && args[index].startsWith('-')) index += GIT_OPTIONS_WITH_VALUE.has(args[index]) ? 2 : 1

  const sub = args[index]
  const rest = args.slice(index + 1)
  const has = (...flags: string[]) => rest.some(arg => flags.includes(arg) || flags.some(flag => flag.endsWith('*') && arg.startsWith(flag.slice(0, -1))))

  if (sub === 'push') return has('-f', '--force*', '--mirror', '--delete', '-d') || rest.some(arg => arg.startsWith('+')) ? 'raw-destructive' : 'raw-push'
  if (sub === 'commit') return has('--amend') ? 'raw-destructive' : 'raw-commit'
  if (sub === 'rebase') return 'raw-destructive'
  if (sub === 'pull') return 'raw-destructive'
  if (sub === 'branch') return has('-D', '--delete', '-f', '--force') ? 'raw-destructive' : 'other'
  if (sub === 'stash') return rest[0] === 'drop' || rest[0] === 'clear' ? 'raw-destructive' : 'other'
  if (sub === 'reset') return has('--hard', '--merge', '--keep') ? 'raw-destructive' : 'other'
  if (sub === 'checkout') return has('--', '-f', '--force') ? 'raw-destructive' : 'other'
  if (sub === 'restore') return has('--staged', '-S') && !has('--worktree', '-W') ? 'other' : 'raw-destructive'
  if (sub === 'clean') return rest.some(arg => /^-[a-zA-Z]*f/.test(arg) || arg === '--force') ? 'raw-destructive' : 'other'

  return 'other'
}

function isCurlWrite(args: readonly string[]): boolean {
  return args.some((arg, index) => {
    if (/^(-d|--data|--json|-F|--form|-T|--upload-file)/.test(arg)) return true
    const method = arg === '-X' || arg === '--request' ? args[index + 1] : /^(?:-X|--request=)(.+)$/.exec(arg)?.[1]
    return method !== undefined && !READ_METHODS.has(method.toUpperCase())
  })
}

function isWgetWrite(args: readonly string[]): boolean {
  return args.some((arg, index) => {
    if (/^--(post|body)-(data|file)/.test(arg)) return true
    const method = arg === '--method' ? args[index + 1] : /^--method=(.+)$/.exec(arg)?.[1]
    return method !== undefined && !READ_METHODS.has(method.toUpperCase())
  })
}

export function classifyBash(command: string): BashKind {
  return worstKind(simpleCommands(command).flatMap(commandKinds))
}

export function guardText(kind: BashKind): string | undefined {
  return kind === 'other' ? undefined : `review-kit: внутри прогона ${GUARDED[kind]} запрещена — commit, push и публикация идут через инструменты review-kit (commit_push, review_publish, replies_publish); pull/rebase пользователь делает сам`
}

export function isCommitCommand(name: string | undefined): boolean {
  return name !== undefined && COMMIT_COMMANDS.has(name)
}

export function opensCommitWindow(name: string | undefined, originKind: string | undefined): boolean {
  return isCommitCommand(name) && originKind !== undefined && COMMIT_ORIGINS.has(originKind)
}

export function allowsManualCommit(command: string, commitTurn: boolean, agentId: string | undefined): boolean {
  if (!commitTurn || agentId !== undefined) return false
  const kinds = simpleCommands(command).flatMap(commandKinds)
  return kinds.includes('raw-commit') && kinds.every(kind => kind === 'raw-commit' || kind === 'other')
}

export function addSessionFile(files: readonly string[], path: string): string[] {
  return files.includes(path) ? [...files] : [...files, path]
}

export function sessionFilesBlock(files: readonly string[]): string {
  return `${SESSION_FILES_TITLE}\n\n${files.length > 0 ? files.map(file => `- ${file}`).join('\n') : 'None recorded.'}`
}
