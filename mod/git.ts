import type { PullRequest } from './forge/types.ts'

export const FULL_NOTE = 'после rebase/force-push моего ревью нет в истории — проверено всё от базы PR'

export type Run = (argv: readonly string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export async function recheckBase(run: Run, { lastCommit, head, baseRef }: { lastCommit: string; head: string; baseRef: string }): Promise<{ base: string; mode: 'delta' | 'full'; note?: string }> {
  if ((await run(['git', 'merge-base', '--is-ancestor', lastCommit, head])).exitCode === 0) return { base: lastCommit, mode: 'delta' }
  const primary = await run(['git', 'merge-base', `origin/${baseRef}`, head])
  const merge = primary.exitCode === 0 ? primary : await run(['git', 'merge-base', 'origin/main', head])
  if (merge.exitCode !== 0) throw new Error(`не найдена база перепроверки: нет ни origin/${baseRef}, ни origin/main`)
  return { base: merge.stdout.trim(), mode: 'full', note: FULL_NOTE }
}
export async function gitText(run: Run, args: string[], init?: { env?: Record<string, string> }): Promise<string> {
  const result = await run(['git', '-c', 'core.quotePath=false', ...args], init)
  if (result.exitCode !== 0) throw new Error(`git ${args[0]}: ${result.stderr.trim() || `код ${result.exitCode}`}`)
  return result.stdout
}

function splitZ(text: string): string[] {
  return text.split('\0').filter(Boolean)
}

export async function changedFiles(run: Run, base: string, head: string): Promise<string[]> {
  return splitZ(await gitText(run, ['diff', '--name-only', '-z', '--no-renames', base, head])).sort()
}

export async function treeEntries(run: Run, rev: string): Promise<Map<string, string>> {
  return new Map(splitZ(await gitText(run, ['ls-tree', '-r', '-z', rev])).map(entry => {
    const [meta, path] = entry.split('\t')
    return [path, meta.split(' ')[1]] as const
  }))
}

export async function binaryFiles(run: Run, base: string, head: string): Promise<Set<string>> {
  const rows = splitZ(await gitText(run, ['diff', '--numstat', '-z', '--no-renames', base, head])).map(record => record.split('\t'))
  return new Set(rows.filter(row => row.length === 3 && row[0] === '-').map(row => row[2]))
}

export async function showFile(run: Run, rev: string, path: string): Promise<string> {
  return gitText(run, ['show', `${rev}:${path}`])
}

export async function fileDiff(run: Run, base: string, head: string, path: string): Promise<string> {
  return gitText(run, ['diff', '--no-color', '--no-renames', base, head, '--', path])
}

export async function snapshot(run: Run, { paths, indexFile }: { paths: string[]; indexFile: string }): Promise<string> {
  if (paths.length === 0) throw new Error('snapshot: нет путей раунда')
  const env = { GIT_INDEX_FILE: indexFile }
  await gitText(run, ['read-tree', 'HEAD'], { env })
  await gitText(run, ['add', '-A', '--', ...paths], { env })
  const tree = (await gitText(run, ['write-tree'], { env })).trim()
  return (await gitText(run, ['commit-tree', tree, '-p', 'HEAD', '-m', 'review-kit snapshot'])).trim()
}

const CLAUDE_DIR = '.claude'
const EXECUTABLE_NAMES = ['.mcp.json']
const EXECUTABLE_IN_CLAUDE = ['settings.json', 'settings.local.json']
const EXECUTABLE_DIRS = ['hooks', 'agents', 'commands', 'skills']
const SCRIPT = /\.(sh|bash|js|mjs|cjs|ts|py)$/
const INSTRUCTION_NAMES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']

function claudeKind(path: string): 'executable' | 'instructions' | null {
  const parts = path.split('/')
  const name = parts[parts.length - 1]
  if (parts.slice(0, -1).includes('.claude-plugin') || EXECUTABLE_NAMES.includes(name)) return 'executable'
  if (INSTRUCTION_NAMES.includes(name)) return 'instructions'
  const at = parts.lastIndexOf(CLAUDE_DIR, parts.length - 2)
  if (at < 0) return null
  const inside = parts.slice(at + 1)
  if (inside[0] === 'rules' && inside.length > 1) return 'instructions'
  if (inside.length === 1 ? EXECUTABLE_IN_CLAUDE.includes(name) || SCRIPT.test(name) : EXECUTABLE_DIRS.includes(inside[0]) || SCRIPT.test(name)) return 'executable'
  return null
}

export function claudeCodeChanges(changed: string[]): { executable: string[]; instructions: string[] } {
  return { executable: changed.filter(path => claudeKind(path) === 'executable'), instructions: changed.filter(path => claudeKind(path) === 'instructions') }
}

export function reviewed(paths: string[]): string[] {
  return paths.filter(path => !path.split('/').slice(0, -1).includes(CLAUDE_DIR))
}

export interface SwitchInput {
  number: number
  headRef: string
  headSha: string
  baseRef: string
  own: boolean
  pullRef: string
}

export interface SwitchPlan {
  target: string
  final: string
  base: string
  detached: boolean
  baseFallback: boolean
  headRef: string
  own: boolean
}

export async function isAncestor(run: Run, a: string, b: string): Promise<boolean> {
  return (await run(['git', 'merge-base', '--is-ancestor', a, b])).exitCode === 0
}

async function hasRef(run: Run, ref: string): Promise<boolean> {
  return (await run(['git', 'rev-parse', '-q', '--verify', ref])).exitCode === 0
}

function holderOf(porcelain: string, branch: string): string {
  const rows = porcelain.split('\n')
  const at = rows.indexOf(`branch refs/heads/${branch}`)
  if (at < 0) return ''
  return rows.slice(0, at).reverse().find(line => line.startsWith('worktree '))?.slice('worktree '.length) ?? ''
}

export async function fetchHead(run: Run, input: SwitchInput): Promise<{ target: string; detached: boolean }> {
  const remote = await run(['git', 'ls-remote', '--exit-code', 'origin', `refs/heads/${input.headRef}`])
  if (remote.exitCode === 0) await gitText(run, ['fetch', '-q', 'origin', `+refs/heads/${input.headRef}:refs/remotes/origin/${input.headRef}`])
  else await run(['git', 'update-ref', '-d', `refs/remotes/origin/${input.headRef}`])
  const branchTip = remote.exitCode === 0 ? (await gitText(run, ['rev-parse', `origin/${input.headRef}`])).trim() : ''
  if (branchTip === input.headSha) return { target: branchTip, detached: false }
  const pulled = await run(['git', 'fetch', '-q', 'origin', input.pullRef])
  if (pulled.exitCode !== 0) throw new Error(`на сервере нет ни ветки ${input.headRef}, ни ${input.pullRef}`)
  const target = (await gitText(run, ['rev-parse', 'FETCH_HEAD'])).trim()
  if (target !== input.headSha) throw new Error(`PR ${input.number} изменился во время подготовки (ожидался ${input.headSha})`)
  return { target, detached: true }
}

async function ownFinal(run: Run, headRef: string, target: string): Promise<string> {
  if (!(await hasRef(run, `refs/heads/${headRef}`))) return target
  const local = (await gitText(run, ['rev-parse', `refs/heads/${headRef}`])).trim()
  if (await isAncestor(run, target, local)) return local
  if (!(await isAncestor(run, local, target))) throw new Error(`своя ветка ${headRef} разошлась с origin — разберитесь вручную`)
  return target
}

async function mergedBase(run: Run, final: string, baseTip: string): Promise<string> {
  const merges = (await gitText(run, ['rev-list', '--first-parent', '--merges', '--reverse', `${final}..${baseTip}`])).split('\n').filter(Boolean)
  for (const merge of merges) {
    if (await isAncestor(run, final, `${merge}^2`)) return (await gitText(run, ['merge-base', `${merge}^1`, final])).trim()
  }
  throw new Error(`PR уже в ${baseTip} без merge-коммита — базу ревью не определить`)
}

export async function planSwitch(run: Run, input: SwitchInput): Promise<SwitchPlan> {
  const busy = holderOf(await gitText(run, ['worktree', 'list', '--porcelain']), input.headRef)
  const root = (await gitText(run, ['rev-parse', '--show-toplevel'])).trim()
  if (busy && busy !== root) throw new Error(`ветка ${input.headRef} занята worktree ${busy}`)
  const { target, detached } = await fetchHead(run, input)
  const final = !detached && input.own ? await ownFinal(run, input.headRef, target) : target
  await run(['git', 'fetch', '-q', 'origin', `+refs/heads/${input.baseRef}:refs/remotes/origin/${input.baseRef}`])
  const hasBase = await hasRef(run, `refs/remotes/origin/${input.baseRef}`)
  if (!hasBase && (await run(['git', 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main'])).exitCode !== 0) {
    throw new Error(`на сервере нет ни ветки ${input.baseRef}, ни main`)
  }
  const baseTip = hasBase ? `origin/${input.baseRef}` : 'origin/main'
  const base = (await isAncestor(run, final, baseTip)) ? await mergedBase(run, final, baseTip) : (await gitText(run, ['merge-base', baseTip, final])).trim()
  return { target, final, base, detached, baseFallback: !hasBase, headRef: input.headRef, own: input.own }
}

export async function applySwitch(run: Run, plan: SwitchPlan): Promise<{ head: string; base: string; detached: boolean; baseFallback: boolean }> {
  if ((await gitText(run, ['status', '--porcelain', '-uno', '--ignore-submodules=all'])).trim()) throw new Error('в дереве изменены отслеживаемые файлы — сначала stash')
  const sw = async (...args: string[]) => {
    const result = await run(['git', 'switch', '-q', ...args])
    if (result.exitCode !== 0) throw new Error(`git switch не удался: ${result.stderr.trim()}`)
  }
  if (plan.detached) await sw('--detach', plan.target)
  else if (!plan.own) await sw('-C', plan.headRef, `origin/${plan.headRef}`)
  else if (!(await hasRef(run, `refs/heads/${plan.headRef}`))) await sw('-c', plan.headRef, `origin/${plan.headRef}`)
  else {
    await sw(plan.headRef)
    if ((await gitText(run, ['rev-parse', 'HEAD'])).trim() !== plan.final) await gitText(run, ['merge', '-q', '--ff-only', `origin/${plan.headRef}`])
  }
  return { head: (await gitText(run, ['rev-parse', 'HEAD'])).trim(), base: plan.base, detached: plan.detached, baseFallback: plan.baseFallback }
}

export const STASH_PREFIX = 'review-kit:'
const OPERATIONS = [['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']] as const
const MARKER_LINE = '^(<<<<<<<|>>>>>>>)( |$)'
const BASE_BRANCH = 'main'
const REVIEW_WORKTREE = /^pr-(\d+)-/

export type RoundState = 'commit' | 'push' | 'pushed'
export type IsActive = (path: string, pr: number) => Promise<boolean>

export interface ReviewWorktree {
  path: string
  pr: number
  branch: string
  active: boolean
  dirty: boolean
}

export function messageProblem(message: string): string | undefined {
  if (/[\r\n]/.test(message)) return 'сообщение — одна строка, без переводов строки'
  if (!message.trim()) return 'сообщение пустое'
  if (message !== message.trim()) return 'пробел в начале или в конце сообщения — git его срежет, и повтор не узнает коммит'
  return undefined
}

export async function roundState(run: Run, { branch, roundBase, message, firstParent = false }: { branch: string; roundBase: string; message: string; firstParent?: boolean }): Promise<{ state: RoundState; roundBase: string }> {
  await run(['git', 'fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
  const head = (await gitText(run, ['rev-parse', 'HEAD'])).trim()
  const parents = (await gitText(run, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').slice(1)
  const parent = parents.length === 1 || firstParent ? parents[0] ?? '' : ''
  const base = head === roundBase || parent === roundBase ? roundBase : (await gitText(run, ['merge-base', 'HEAD', `origin/${branch}`])).trim()
  if (head === base) return { state: 'commit', roundBase: base }
  const subject = (await gitText(run, ['log', '-1', '--format=%s'])).trim()
  if (parent !== base) throw new Error(`HEAD ${head.slice(0, 7)} не продолжает базу раунда ${base.slice(0, 7)} одним коммитом`)
  if (subject !== message) throw new Error(`коммит раунда уже есть с сообщением «${subject}» — передайте его же`)
  return { state: (await isAncestor(run, 'HEAD', `origin/${branch}`)) ? 'pushed' : 'push', roundBase: base }
}

export async function headShift(run: Run, { saved, head, branch }: { saved: string; head: string; branch: string }): Promise<'same' | 'pushed' | 'moved'> {
  if (head === saved) return 'same'
  return (await isAncestor(run, saved, head)) && (await isAncestor(run, head, `origin/${branch}`)) ? 'pushed' : 'moved'
}

export async function foreignChanges(run: Run, paths: string[]): Promise<string[]> {
  const changed = (await gitText(run, ['diff', '--name-only', '--ignore-submodules=all', 'HEAD'])).split('\n').filter(Boolean)
  return changed.filter(path => !paths.includes(path))
}

export async function commitRound(run: Run, { paths, message }: { paths: string[]; message: string }): Promise<{ ok: true } | { ok: false; output: string }> {
  if (paths.length === 0) return { ok: false, output: 'нет путей раунда — коммитить нечего' }
  const glob = paths.find(path => /^:|[*?[]/.test(path))
  if (glob) return { ok: false, output: `путь ${glob} — pathspec или glob, нужен путь к файлу` }
  await gitText(run, ['add', '-A', '--', ...paths])
  const staged = (await gitText(run, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean)
  const extra = staged.filter(path => !paths.includes(path))
  if (extra.length) {
    await run(['git', 'reset', '-q', '--', ...paths])
    return { ok: false, output: `в индексе есть файлы вне подтверждённого списка (их staging не тронут):\n${extra.join('\n')}` }
  }
  if (staged.length === 0) return { ok: false, output: 'в подтверждённых путях нечего коммитить' }
  const committed = await run(['git', 'commit', '-q', '-m', message])
  return committed.exitCode === 0 ? { ok: true } : { ok: false, output: `${committed.stdout}${committed.stderr}`.trim() }
}

export async function operationInProgress(run: Run): Promise<string | undefined> {
  for (const [name, operation] of OPERATIONS) {
    const path = (await gitText(run, ['rev-parse', '--git-path', name])).trim()
    if ((await run(['test', '-e', path])).exitCode === 0) return operation
  }
  return undefined
}

export async function unmergedPaths(run: Run): Promise<string[]> {
  return (await gitText(run, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean)
}

export async function mergeBase(run: Run, baseRef: string): Promise<{ conflicts: string[] }> {
  const merged = await run(['git', 'merge', '-q', '--no-ff', '--no-commit', `origin/${baseRef}`])
  const conflicts = await unmergedPaths(run)
  if (conflicts.length) return { conflicts }
  if (await hasRef(run, 'MERGE_HEAD')) await gitText(run, ['merge', '--abort'])
  if (merged.exitCode !== 0) throw new Error(`git merge: ${`${merged.stderr}${merged.stdout}`.trim()}`)
  return { conflicts: [] }
}

export async function mergeProblem(run: Run, paths: string[]): Promise<string | undefined> {
  if (!(await hasRef(run, 'MERGE_HEAD'))) return 'слияния нет — в дереве не идёт merge'
  if (paths.length === 0) return 'нет файлов с конфликтом в paths'
  const glob = paths.find(path => /^:|[*?[]/.test(path))
  if (glob) return `путь ${glob} — pathspec или glob, нужен путь к файлу`
  const unresolved = (await unmergedPaths(run)).filter(path => !paths.includes(path))
  if (unresolved.length) return `не разрешены и не переданы в paths:\n${unresolved.join('\n')}`
  const marked = (await run(['grep', '-lsE', MARKER_LINE, '--', ...paths])).stdout.split('\n').filter(Boolean)
  return marked.length ? `в файлах остались маркеры конфликта:\n${marked.join('\n')}` : undefined
}

export async function commitMerge(run: Run, { paths, message }: { paths: string[]; message: string }): Promise<{ ok: true } | { ok: false; output: string }> {
  const problem = await mergeProblem(run, paths)
  if (problem) return { ok: false, output: problem }
  await gitText(run, ['add', '-A', '--', ...paths])
  const left = await unmergedPaths(run)
  if (left.length) return { ok: false, output: `не разрешены:\n${left.join('\n')}` }
  const committed = await run(['git', 'commit', '-q', '-m', message])
  return committed.exitCode === 0 ? { ok: true } : { ok: false, output: `${committed.stdout}${committed.stderr}`.trim() }
}

export async function pushRound(run: Run, branch: string): Promise<{ ok: true } | { ok: false; rejected: boolean; output: string }> {
  const pushed = await run(['git', 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`])
  if (pushed.exitCode === 0) return { ok: true }
  const output = pushed.stderr.trim()
  return { ok: false, rejected: /\[rejected\]|non-fast-forward|fetch first|Updates were rejected/.test(output), output }
}

export async function unpushed(run: Run, branch: string): Promise<string[]> {
  const range = (await run(['git', 'rev-parse', '-q', '--verify', `origin/${branch}`])).exitCode === 0 ? `origin/${branch}..HEAD` : 'HEAD'
  return (await gitText(run, ['log', '--oneline', range])).split('\n').filter(Boolean)
}

export async function reviewStashes(run: Run): Promise<Array<{ sha: string; message: string; branch: string }>> {
  return (await gitText(run, ['stash', 'list', '--format=%H\t%gs'])).split('\n').filter(Boolean).flatMap(line => {
    const [sha, subject = ''] = line.split('\t')
    const at = subject.indexOf(': ')
    const message = at >= 0 ? subject.slice(at + 2) : ''
    if (!message.startsWith(STASH_PREFIX)) return []
    const branch = subject.slice(0, at).replace(/^WIP on /, '').replace(/^On /, '').trim()
    return [{ sha, message, branch: branch === '(no branch)' ? '' : branch }]
  })
}

export async function stashAction(run: Run, sha: string, action: 'apply' | 'drop'): Promise<{ ok: boolean; conflict?: boolean; error?: string }> {
  const index = (await gitText(run, ['stash', 'list', '--format=%H'])).split('\n').indexOf(sha)
  if (index < 0) return { ok: false, error: 'stash уже не найден' }
  const result = await run(['git', 'stash', action === 'apply' ? 'pop' : 'drop', `stash@{${index}}`])
  if (result.exitCode === 0) return { ok: true }
  const unmerged = (await gitText(run, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean)
  return unmerged.length ? { ok: false, conflict: true, error: `применён с конфликтом в: ${unmerged.join(', ')}; stash сохранён` } : { ok: false, error: `${result.stderr}${result.stdout}`.trim() }
}

async function allOnOrigin(run: Run, ref: string): Promise<boolean> {
  return (await gitText(run, ['rev-list', ref, '--not', '--remotes=origin'])).trim() === ''
}

async function busyBranches(run: Run): Promise<Set<string>> {
  return new Set((await gitText(run, ['worktree', 'list', '--porcelain'])).split('\n').filter(line => line.startsWith('branch refs/heads/')).map(line => line.slice('branch refs/heads/'.length)))
}

export async function branchCandidates(run: Run, { open, closed, me }: { open: PullRequest[]; closed: PullRequest[]; me: string }): Promise<Array<{ name: string; kind: 'pr' | 'no-pr'; reason: string }>> {
  await run(['git', 'fetch', '-q', 'origin', '--prune'])
  const busy = await busyBranches(run)
  const names = (await gitText(run, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n').filter(Boolean)
  const rows: Array<{ name: string; kind: 'pr' | 'no-pr'; reason: string }> = []
  for (const name of names) {
    if (name === BASE_BRANCH || busy.has(name) || !(await allOnOrigin(run, name))) continue
    const opened = open.find(pull => pull.headRef === name)
    const done = closed.find(pull => pull.headRef === name)
    if (opened && opened.author.toLowerCase() === me.toLowerCase()) continue
    if (opened) rows.push({ name, kind: 'pr', reason: `чужой открытый PR #${opened.number} — коммиты на origin` })
    else if (done) rows.push({ name, kind: 'pr', reason: `PR #${done.number} ${done.merged ? 'влит' : 'закрыт'} — коммиты на origin` })
    else rows.push({ name, kind: 'no-pr', reason: 'PR нет среди последних — коммиты на origin' })
  }
  return rows
}

export async function deleteBranches(run: Run, names: string[]): Promise<{ deleted: string[]; skipped: Array<{ name: string; reason: string }> }> {
  const busy = await busyBranches(run)
  const deleted: string[] = []
  const skipped: Array<{ name: string; reason: string }> = []
  for (const name of names) {
    if (name === BASE_BRANCH || busy.has(name)) skipped.push({ name, reason: 'ветка занята или базовая' })
    else if (!(await allOnOrigin(run, name))) skipped.push({ name, reason: 'есть коммиты, которых нет на origin' })
    else {
      const result = await run(['git', 'branch', '-D', name])
      if (result.exitCode === 0) deleted.push(name)
      else skipped.push({ name, reason: result.stderr.trim() })
    }
  }
  return { deleted, skipped }
}

async function worktrees(run: Run): Promise<Array<{ path: string; branch: string }>> {
  const rows: Array<{ path: string; branch: string }> = []
  for (const line of (await gitText(run, ['worktree', 'list', '--porcelain'])).split('\n')) {
    if (line.startsWith('worktree ')) rows.push({ path: line.slice('worktree '.length), branch: '' })
    else if (line.startsWith('branch refs/heads/') && rows.length) rows[rows.length - 1].branch = line.slice('branch refs/heads/'.length)
  }
  return rows
}

export async function mainBranch(run: Run): Promise<string> {
  return (await worktrees(run))[0]?.branch ?? ''
}

export async function inMainTree(run: Run): Promise<boolean> {
  const [main] = await worktrees(run)
  return (await gitText(run, ['rev-parse', '--show-toplevel'])).trim() === main?.path
}

export async function reviewWorktrees(run: Run, isActive: IsActive): Promise<ReviewWorktree[]> {
  const [main, ...rest] = await worktrees(run)
  const home = `${main.path}/.claude/worktrees`
  const found: ReviewWorktree[] = []
  for (const { path, branch } of rest) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    const match = REVIEW_WORKTREE.exec(name)
    if (path.slice(0, path.lastIndexOf('/')) !== home || !match) continue
    const pr = Number(match[1])
    const dirty = (await gitText(run, ['-C', path, 'status', '--porcelain', '--ignore-submodules=all'])).trim() !== ''
    found.push({ path, pr, branch, active: await isActive(path, pr), dirty })
  }
  return found
}

export async function worktreeCandidates(run: Run, { open, me, isActive }: { open: PullRequest[]; me: string; isActive: IsActive }): Promise<Array<{ path: string; pr: number; branch: string; deleteBranch: boolean }>> {
  const rows: Array<{ path: string; pr: number; branch: string; deleteBranch: boolean }> = []
  for (const tree of await reviewWorktrees(run, isActive)) {
    if (tree.active || tree.dirty) continue
    const mineOpen = open.some(pull => pull.headRef === tree.branch && pull.author.toLowerCase() === me.toLowerCase())
    const deleteBranch = Boolean(tree.branch) && tree.branch !== BASE_BRANCH && !mineOpen && (await allOnOrigin(run, tree.branch))
    rows.push({ path: tree.path, pr: tree.pr, branch: tree.branch, deleteBranch })
  }
  return rows
}

export async function holder(run: Run, branch: string, isActive: IsActive): Promise<ReviewWorktree | null> {
  const here = (await gitText(run, ['rev-parse', '--show-toplevel'])).trim()
  return (await reviewWorktrees(run, isActive)).find(tree => tree.branch === branch && tree.path !== here) ?? null
}

export async function removeWorktrees(run: Run, paths: string[], { confirmed, isActive }: { confirmed: boolean; isActive: IsActive }): Promise<{ removed: string[]; skipped: Array<{ path: string; reason: string }> }> {
  const known = new Map((await reviewWorktrees(run, isActive)).map(tree => [tree.path, tree]))
  const removed: string[] = []
  const skipped: Array<{ path: string; reason: string }> = []
  for (const path of paths) {
    const tree = known.get(path)
    if (!tree) skipped.push({ path, reason: 'не worktree ревью' })
    else if (!confirmed && (tree.active || tree.dirty)) skipped.push({ path, reason: 'ревью идёт или есть изменения' })
    else {
      await gitText(run, ['worktree', 'remove', '--force', path])
      removed.push(path)
    }
  }
  return { removed, skipped }
}

export function worktreeName(root: string, number: number, headRef: string): string {
  return `${root}/.claude/worktrees/pr-${number}-${headRef.replace(/[^A-Za-z0-9._-]/g, '-')}`
}

export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

async function prBase(run: Run, baseRef: string, target: string): Promise<string> {
  for (const ref of [...new Set([baseRef, 'main'])]) {
    await run(['git', 'fetch', '-q', 'origin', `+refs/heads/${ref}:refs/remotes/origin/${ref}`])
    const merge = await run(['git', 'merge-base', `origin/${ref}`, target])
    if (merge.exitCode === 0) return merge.stdout.trim()
  }
  throw new Error(`базу PR не найти (нет ни origin/${baseRef}, ни origin/main) — настройки Claude Code не проверить, вкладку не открываю`)
}

export async function createReviewWorktree(run: Run, input: { root: string; number: number; headRef: string; headSha: string; baseRef: string; pullRef: string; isActive: IsActive }): Promise<{ path: string; created: boolean; executable: string[]; instructions: string[] }> {
  const path = worktreeName(input.root, input.number, input.headRef)
  const { target } = await fetchHead(run, { ...input, own: false })
  const { executable, instructions } = claudeCodeChanges(await changedFiles(run, await prBase(run, input.baseRef, target), target))
  if (executable.length) return { path, created: false, executable, instructions }
  const exists = (await worktrees(run)).some(tree => tree.path === path)
  if (!exists) await gitText(run, ['worktree', 'add', '-q', '--detach', path, target])
  else {
    if (await input.isActive(path, input.number)) throw new Error(`ревью PR ${input.number} уже идёт в ${path} — продолжайте в той вкладке`)
    if ((await gitText(run, ['-C', path, 'status', '--porcelain', '--ignore-submodules=all'])).trim()) throw new Error(`в worktree ${path} есть изменения — уберите их или удалите worktree («убери вкладку ${input.number}»)`)
    await gitText(run, ['-C', path, 'switch', '-q', '--detach', target])
  }
  await gitText(run, ['-C', path, 'submodule', 'update', '--init', '-q'])
  return { path, created: !exists, executable, instructions }
}

export async function excludeFile(run: Run): Promise<string> {
  return (await gitText(run, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'])).trim()
}
