import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { MANIFEST, manualBumpProblem } from './version.mjs'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

const ref = process.argv[2]
if (!ref) {
  console.error('использование: node .github/scripts/no-manual-version.mjs <base-ref>')
  process.exit(2)
}
const before = JSON.parse(git('show', `${git('merge-base', ref, 'HEAD')}:${MANIFEST}`)).version
const after = JSON.parse(readFileSync(MANIFEST, 'utf8')).version
const problem = manualBumpProblem({ before, after })
if (problem) {
  console.error(problem)
  process.exit(1)
}
console.log(`версия не тронута: ${after}`)
