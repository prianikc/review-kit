import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { MANIFEST, bump, levelOf, pluginChanged } from './version.mjs'

const run = (cmd, ...args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()
const { PR_NUMBER, PR_TITLE, PR_BODY = '', PR_LABELS = '[]', BASE_SHA, MERGE_SHA } = process.env

const changed = run('git', 'diff', '--name-only', `${BASE_SHA}...${MERGE_SHA}`).split('\n').filter(Boolean)
if (!pluginChanged(changed)) {
  console.log(`PR #${PR_NUMBER}: файлы плагина не менялись — релиз не нужен`)
  process.exit(0)
}
run('git', 'pull', '--ff-only', 'origin', 'main')
const text = readFileSync(MANIFEST, 'utf8')
const current = JSON.parse(text).version
const level = levelOf(JSON.parse(PR_LABELS))
const next = bump(current, level)
const tag = `v${next}`
if (run('git', 'tag', '--list', tag)) {
  console.error(`тег ${tag} уже есть — релиз не перезаписывается; разберитесь вручную`)
  process.exit(1)
}
writeFileSync(MANIFEST, text.replace(`"version": "${current}"`, `"version": "${next}"`))
run('git', 'commit', '-q', '-m', `review-kit ${next}: ${PR_TITLE} (#${PR_NUMBER})`, '--', MANIFEST)
run('git', 'tag', tag)
run('git', 'push', 'origin', 'HEAD:refs/heads/main', tag)
run('gh', 'release', 'create', tag, '--title', `${next}: ${PR_TITLE}`, '--notes', `${PR_BODY.trim()}\n\nPR #${PR_NUMBER}`.trim())
console.log(`релиз ${tag} (${level}, было ${current})`)
