export const FULL_NOTE = 'после rebase/force-push моего ревью нет в истории — проверено всё от базы PR'

export type Run = (argv: readonly string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export async function recheckBase(run: Run, { lastCommit, head, baseRef }: { lastCommit: string; head: string; baseRef: string }): Promise<{ base: string; mode: 'delta' | 'full'; note?: string }> {
  if ((await run(['git', 'merge-base', '--is-ancestor', lastCommit, head])).exitCode === 0) return { base: lastCommit, mode: 'delta' }
  const primary = await run(['git', 'merge-base', `origin/${baseRef}`, head])
  const merge = primary.exitCode === 0 ? primary : await run(['git', 'merge-base', 'origin/main', head])
  if (merge.exitCode !== 0) throw new Error(`не найдена база перепроверки: нет ни origin/${baseRef}, ни origin/main`)
  return { base: merge.stdout.trim(), mode: 'full', note: FULL_NOTE }
}
