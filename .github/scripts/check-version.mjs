import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { versionProblem } from './version.mjs'

const MANIFEST = '.claude-plugin/plugin.json'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

const ref = process.argv[2]
if (!ref) {
  console.error('использование: node .github/scripts/check-version.mjs <base-ref>')
  process.exit(2)
}
const base = git('merge-base', ref, 'HEAD')
const changed = git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean)
const before = JSON.parse(git('show', `${base}:${MANIFEST}`)).version
const after = JSON.parse(readFileSync(MANIFEST, 'utf8')).version
const problem = versionProblem({ changed, before, after })
if (problem) {
  console.error(problem)
  process.exit(1)
}
console.log(`версия: ок (${before} → ${after})`)
