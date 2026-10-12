export const KIT_OK_SENTINEL = 'review-kit:commit-push:ok'
export const POST_OK_SENTINEL = 'review-kit:post-review:ok'
export const POST_REPLIES_OK_SENTINEL = 'review-kit:post-replies:ok'

export interface PostReviewCall {
  pr: number
  payload: string
}

export interface PublishMark {
  action: 'publish-review' | 'publish-replies'
  pr: number
  payload: string
  payloadText: string
}

export interface CommitPushCall {
  branch: string
  baseHead: string
  message: string
  paths: string[]
}

export interface CommitPushMark extends CommitPushCall {
  action: 'commit-push'
  pr: number
}

export type BashKind = 'kit-commit-push' | 'kit-post-review' | 'kit-post-replies' | 'kit-noncanonical' | 'raw-commit' | 'raw-push' | 'raw-destructive' | 'raw-write' | 'other'

export interface Classified {
  kind: BashKind
  call?: CommitPushCall
  post?: PostReviewCall
}

export interface GuardInput {
  isRunActive: boolean
  classified: Classified
  mark: CommitPushMark | undefined
  publishMark?: PublishMark
  usage: string
}

export type GuardVerdict = { allow: true; consumesMark: boolean } | { allow: false; reason: string }

const TOKEN = /[ \t]*(?:"((?:[^"\\$`\n]|\\["\\])*)"|([A-Za-z0-9._/@:+=,-]+))(?=[ \t]|$)/y

function tokenize(text: string): string[] | undefined {
  const tokens: string[] = []
  TOKEN.lastIndex = 0

  while (TOKEN.lastIndex < text.length) {
    const match = TOKEN.exec(text)
    if (!match) return undefined
    tokens.push(match[1] !== undefined ? match[1].replace(/\\(["\\])/g, '$1') : match[2])
  }

  return tokens
}

const MERGED_STDERR = / 2>&1$/

export function messageProblem(message: string): string | undefined {
  if (/[\r\n]/.test(message)) return 'сообщение — одна строка, без переводов строки'
  if (!message.trim()) return 'сообщение пустое'
  if (message !== message.trim()) return 'пробел в начале или в конце сообщения — git его срежет, и повтор не узнает коммит'
  if (/["$`\\]/.test(message)) return 'в сообщении нельзя использовать ", $, ` и \\'
  return undefined
}

export function parseKitCall({ command, scripts }: { command: string; scripts: readonly string[] }): CommitPushCall | undefined {
  if (command.includes('\n')) return undefined
  const tokens = tokenize(command.trim().replace(MERGED_STDERR, ''))
  if (!tokens) return undefined

  const [bash, script, f1, branch, f2, baseHead, f3, message, dashes, ...paths] = tokens
  const isCanonical =
    bash === 'bash' && scripts.includes(script) && script.endsWith('tools/commit-push') &&
    f1 === '--branch' && f2 === '--base-head' && f3 === '--message' && dashes === '--' && paths.length > 0
  if (!isCanonical || !branch || !baseHead || !message || paths.some(path => path === '')) return undefined

  return { branch, baseHead, message, paths }
}

export function parsePostCall({ command, scripts }: { command: string; scripts: readonly string[] }): PostReviewCall | undefined {
  return parseForgejoCall({ command, scripts, verb: 'post-review' })
}

export function parseRepliesCall({ command, scripts }: { command: string; scripts: readonly string[] }): PostReviewCall | undefined {
  return parseForgejoCall({ command, scripts, verb: 'post-replies' })
}

function parseForgejoCall({ command, scripts, verb: wanted }: { command: string; scripts: readonly string[]; verb: string }): PostReviewCall | undefined {
  if (command.includes('\n')) return undefined
  const tokens = tokenize(command.trim().replace(MERGED_STDERR, ''))
  if (!tokens) return undefined

  const [python, script, verb, pr, flag, payload, ...rest] = tokens
  const isCanonical = python === 'python3' && scripts.includes(script) && script.endsWith('tools/forgejo.py') &&
    verb === wanted && /^\d+$/.test(pr ?? '') && flag === '--payload' && !!payload && rest.length === 0

  return isCanonical ? { pr: Number(pr), payload } : undefined
}

export function classifyBash({ command, scripts }: { command: string; scripts: readonly string[] }): Classified {
  const call = parseKitCall({ command, scripts })
  if (call) return { kind: 'kit-commit-push', call }
  const post = parsePostCall({ command, scripts })
  if (post) return { kind: 'kit-post-review', post }
  const replies = parseRepliesCall({ command, scripts })
  if (replies) return { kind: 'kit-post-replies', post: replies }
  if (command.includes('tools/commit-push') || /tools\/forgejo\.py\S*\s+post-(review|replies)/.test(command) || /(^|\s)-m\s+forgejo\b[^\n]*post-(review|replies)/.test(command)) return { kind: 'kit-noncanonical' }

  return { kind: worstKind(simpleCommands(command).map(classifySimple)) }
}

const SEVERITY: readonly BashKind[] = ['raw-destructive', 'raw-push', 'raw-commit', 'raw-write', 'other']

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

const COMMAND_PREFIXES = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'env', 'xargs', '$'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])

function classifySimple(tokens: readonly string[]): BashKind {
  let index = 0
  while (index < tokens.length && (/^\w+=/.test(tokens[index]) || COMMAND_PREFIXES.has(tokens[index]))) index++

  const name = (tokens[index] ?? '').split('/').pop() ?? ''
  const args = tokens.slice(index + 1)

  if (SHELLS.has(name) && args[0] === '-c' && args[1]) return worstKind(simpleCommands(args[1]).map(classifySimple))
  if (name === 'eval') return worstKind(simpleCommands(args.join(' ')).map(classifySimple))
  if (name === 'git') return classifyGit(args)
  if (name === 'curl') return isCurlWrite(args) ? 'raw-write' : 'other'
  if (name === 'wget') return isWgetWrite(args) ? 'raw-write' : 'other'

  return 'other'
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
  if (sub === 'branch') return has('-D', '--delete', '-f', '--force') ? 'raw-destructive' : 'other'
  if (sub === 'stash') return rest[0] === 'drop' || rest[0] === 'clear' ? 'raw-destructive' : 'other'
  if (sub === 'reset') return has('--hard', '--merge', '--keep') ? 'raw-destructive' : 'other'
  if (sub === 'checkout') return has('--', '-f', '--force') ? 'raw-destructive' : 'other'
  if (sub === 'restore') return has('--staged', '-S') && !has('--worktree', '-W') ? 'other' : 'raw-destructive'
  if (sub === 'clean') return rest.some(arg => /^-[a-zA-Z]*f/.test(arg) || arg === '--force') ? 'raw-destructive' : 'other'

  return 'other'
}

const READ_METHODS = new Set(['GET', 'HEAD'])

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

function matchesMark(call: CommitPushCall, mark: CommitPushMark): boolean {
  return (
    call.branch === mark.branch && call.baseHead === mark.baseHead && call.message === mark.message &&
    call.paths.length === mark.paths.length && call.paths.every((path, index) => path === mark.paths[index])
  )
}

export function kitScriptPaths(pluginRoot: string): string[] {
  const marker = '/.claude/skills/'
  return ['commit-push', 'forgejo.py'].flatMap(name => {
    const absolute = `${pluginRoot}/tools/${name}`
    const at = absolute.lastIndexOf(marker)
    return at === -1 ? [absolute] : [absolute, absolute.slice(at + 1)]
  })
}

export function kitUsage(scripts: readonly string[]): string {
  const forms = scripts.map(script =>
    script.endsWith('tools/forgejo.py')
      ? `python3 "${script}" post-review <N> --payload <файл>\nили\npython3 "${script}" post-replies <N> --payload <файл>`
      : `bash "${script}" --branch <ветка> --base-head <sha> --message "<сообщение>" -- <пути>`,
  )
  return `${forms.join('\nили\n')}\nОдна команда в строке; значения — голым словом или в двойных кавычках без $ и \`.`
}

export function decideBash({ isRunActive, classified, mark, publishMark, usage }: GuardInput): GuardVerdict {
  if (!isRunActive || classified.kind === 'other') return { allow: true, consumesMark: false }

  if (classified.kind === 'kit-commit-push' && classified.call) {
    if (!mark) return { allow: false, reason: 'review-kit: нет подтверждения review_confirm(commit-push)' }
    if (!matchesMark(classified.call, mark)) return { allow: false, reason: 'review-kit: аргументы не совпадают с подтверждёнными (ветка, baseHead, сообщение, пути)' }
    return { allow: true, consumesMark: true }
  }

  if ((classified.kind === 'kit-post-review' || classified.kind === 'kit-post-replies') && classified.post) {
    const { post } = classified
    const action = classified.kind === 'kit-post-review' ? 'publish-review' : 'publish-replies'
    if (!publishMark || publishMark.action !== action) return { allow: false, reason: `review-kit: нет подтверждения review_confirm(${action})` }
    if (publishMark.pr !== post.pr || publishMark.payload !== post.payload) return { allow: false, reason: 'review-kit: PR или файл payload не совпадают с подтверждёнными' }
    return { allow: true, consumesMark: true }
  }

  if (classified.kind === 'kit-noncanonical') {
    return { allow: false, reason: `review-kit: скрипт вызывается только так:\n${usage}` }
  }

  return { allow: false, reason: `review-kit: внутри прогона ${classified.kind} запрещён — только через review_confirm и скрипты набора` }
}
