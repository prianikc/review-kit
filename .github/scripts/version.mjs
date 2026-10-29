export const PLUGIN_PATHS = ['.claude-plugin/', 'hooks/', 'mod/', 'funnel/', 'agents/', 'skills/', 'config/', 'types/']
export const MANIFEST = '.claude-plugin/plugin.json'
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const LEVELS = ['major', 'minor']

export function pluginChanged(changed) {
  return changed.some(path => PLUGIN_PATHS.some(prefix => path.startsWith(prefix)))
}

export function levelOf(labels) {
  return LEVELS.find(level => labels.includes(level)) ?? 'patch'
}

export function bump(version, level) {
  const match = SEMVER.exec(version)
  if (!match) throw new Error(`version ${version} не semver (x.y.z)`)
  const [major, minor, patch] = match.slice(1).map(Number)
  if (level === 'major') return `${major + 1}.0.0`
  if (level === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

export function manualBumpProblem({ before, after }) {
  return before === after ? null : `version поднимает GitHub Actions при слиянии — верните ${before} в ${MANIFEST}, нужный уровень — меткой PR major или minor`
}
