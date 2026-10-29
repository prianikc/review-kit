export const PLUGIN_PATHS = ['.claude-plugin/', 'hooks/', 'mod/', 'funnel/', 'agents/', 'skills/', 'config/', 'types/']
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const LISTED = 3

function parts(version) {
  const match = SEMVER.exec(version)
  return match ? match.slice(1).map(Number) : null
}

function greater(after, before) {
  const index = after.findIndex((value, i) => value !== before[i])
  return index >= 0 && after[index] > before[index]
}

export function versionProblem({ changed, before, after }) {
  const plugin = changed.filter(path => PLUGIN_PATHS.some(prefix => path.startsWith(prefix)))
  if (plugin.length === 0) return null
  const listed = `${plugin.slice(0, LISTED).join(', ')}${plugin.length > LISTED ? ` и ещё ${plugin.length - LISTED}` : ''}`
  const [old, next] = [parts(before), parts(after)]
  if (!old || !next) return `version ${!next ? after : before} не semver (x.y.z)`
  if (after === before) return `изменены файлы плагина (${listed}), а version осталась ${after} — поднимите в .claude-plugin/plugin.json`
  return greater(next, old) ? null : `изменены файлы плагина (${listed}), а version ${after} не больше ${before}`
}
