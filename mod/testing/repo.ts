import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Run } from '../git.ts'

export function repo(): { dir: string; run: Run; git: (...args: string[]) => string; commit: (file: string, text: string, message: string) => string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rk-git-')))
  const run: Run = async (argv, init) => {
    const result = spawnSync(argv[0], argv.slice(1), { cwd: init?.cwd ?? dir, env: { ...process.env, ...init?.env }, input: init?.stdin, encoding: 'utf8' })
    return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
  }
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  const commit = (file: string, text: string, message: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
    git('add', '--', file)
    git('commit', '-qm', message)
    return git('rev-parse', 'HEAD')
  }
  return { dir, run, git, commit }
}
