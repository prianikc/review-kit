import type { EngineInterface } from 'claude-code'
import { ADAPTERS, createProvider, selectProvider, withTimeout, type ExplicitConfig } from '../forge/index.ts'
import type { ForgeProvider } from '../forge/types.ts'
import { projectRoot, runner, readJson } from './engine.ts'

export const HTTP_TIMEOUT_MS = 30_000

export const CONFIG_PATH = '.claude/review-kit.local.json'

export const ROADMAP_DIR = 'docs/roadmap'

export const SETTINGS: { options: Record<string, unknown> } = { options: {} }

export const TEST_PROVIDER: { value?: ForgeProvider } = {}

export async function explicitConfig($: EngineInterface): Promise<ExplicitConfig | undefined> {
  const text = await $.fs.read(`${await projectRoot($)}/${CONFIG_PATH}`).then(String, () => '')
  if (!text) return undefined
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    const field = (key: string) => (typeof value[key] === 'string' ? value[key] as string : undefined)
    return { provider: field('provider'), host: field('host'), owner: field('owner'), repo: field('repo') }
  } catch {
    throw new Error(`${CONFIG_PATH}: не JSON`)
  }
}

export async function roadmapDir($: EngineInterface): Promise<string> {
  const text = await $.fs.read(`${await projectRoot($)}/${CONFIG_PATH}`).then(String, () => '')
  try {
    const dir = text ? (JSON.parse(text) as { roadmapDir?: unknown }).roadmapDir : undefined
    return typeof dir === 'string' && dir.trim() ? dir.trim().replace(/\/+$/, '') : ROADMAP_DIR
  } catch {
    return ROADMAP_DIR
  }
}

export async function readTokens($: EngineInterface): Promise<Map<string, string | undefined>> {
  return new Map([
    ['FORGEJO_TOKEN', await $.env.get('FORGEJO_TOKEN')],
    ['GITEA_TOKEN', await $.env.get('GITEA_TOKEN')],
  ])
}

export function useProviderForTests(provider: ForgeProvider | undefined): void {
  TEST_PROVIDER.value = provider
}

export async function forge($: EngineInterface): Promise<ForgeProvider> {
  if (TEST_PROVIDER.value) return TEST_PROVIDER.value
  const remote = await runner($)(['git', 'remote', 'get-url', 'origin'])
  const values = await readTokens($)
  const missing = ADAPTERS.flatMap(adapter => adapter.tokenEnv).filter(name => !values.has(name))
  if (missing.length) throw new Error(`review-kit: мод не читает переменные ${missing.join(', ')} — добавьте их в readTokens`)
  const selection = selectProvider({
    options: SETTINGS.options, config: await explicitConfig($), remoteUrl: remote.exitCode === 0 ? remote.stdout.trim() : '',
    env: name => values.get(name),
  })
  if ('error' in selection) throw new Error(selection.error)
  const sleep = (ms: number) => $.clock.sleep(ms)
  return createProvider(selection, withTimeout((url, init) => $.http.fetch(url, init), sleep, HTTP_TIMEOUT_MS), sleep)
}

export async function botLogins($: EngineInterface): Promise<string[]> {
  return (await readJson<{ bots?: string[] }>($, `${$.plugin.root}/config/funnel.json`, {})).bots ?? []
}
