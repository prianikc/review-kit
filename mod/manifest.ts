export const ROLES = ['correctness', 'quality', 'refuter', 'triage'] as const
export type Role = (typeof ROLES)[number]
export const MAX_RETURNS = 3

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
