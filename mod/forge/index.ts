import { forgejo } from './forgejo.ts'
import type { ForgeAdapter, ForgeProvider, Http, Repo } from './types.ts'

export const ADAPTERS: readonly ForgeAdapter[] = [forgejo]

export interface ExplicitConfig {
  provider?: string
  host?: string
  owner?: string
  repo?: string
}

export type Selection = { adapter: ForgeAdapter; repo: Repo; token: string } | { error: string }

type Chosen = { adapter: ForgeAdapter; repo: Repo } | { error: string }

export function selectProvider({ options, config, remoteUrl, env, adapters = ADAPTERS }: {
  options: Record<string, unknown>
  config?: ExplicitConfig
  remoteUrl: string
  env: (name: string) => string | undefined
  adapters?: readonly ForgeAdapter[]
}): Selection {
  const chosen = config?.provider ? explicit(config, remoteUrl, adapters) : byRemote(options, remoteUrl, adapters)
  if ('error' in chosen) return chosen
  const token = chosen.adapter.tokenEnv.map(name => env(name)).find(value => value?.trim())
  return token ? { ...chosen, token: token.trim() } : { error: `Нет токена ${chosen.adapter.name}: задайте переменную ${chosen.adapter.tokenEnv.join(' или ')} в окружении терминала.` }
}

function explicit(config: ExplicitConfig, remoteUrl: string, adapters: readonly ForgeAdapter[]): Chosen {
  const adapter = adapters.find(item => item.id === config.provider)
  if (!adapter) return { error: `В настройках review-kit указана неизвестная система «${config.provider}»; есть: ${adapters.map(item => item.id).join(', ')}.` }
  const repo = config.host && config.owner && config.repo ? { host: config.host, owner: config.owner, repo: config.repo } : adapter.detect(remoteUrl)
  return repo ? { adapter, repo } : { error: `Remote «${remoteUrl}» не похож на ${adapter.name}: укажите host, owner и repo в .claude/review-kit.local.json.` }
}

function byRemote(options: Record<string, unknown>, remoteUrl: string, adapters: readonly ForgeAdapter[]): Chosen {
  const enabled = adapters.filter(item => options[item.id] !== false)
  if (enabled.length === 0) return { error: 'Все системы выключены — включите нужную в настройках плагина (/plugin → review-kit → Configure options).' }
  if (!remoteUrl.trim()) return { error: 'remote origin не найден: review-kit работает с PR репозитория origin.' }
  const found = enabled.map(adapter => ({ adapter, repo: adapter.detect(remoteUrl) })).find(item => item.repo)
  return found?.repo ? { adapter: found.adapter, repo: found.repo } : { error: `Remote «${remoteUrl}» не распознан; включены: ${enabled.map(item => item.name).join(', ')}. Для своего домена укажите provider, host, owner и repo в .claude/review-kit.local.json.` }
}

export function createProvider(selection: { adapter: ForgeAdapter; repo: Repo; token: string }, http: Http, sleep: (ms: number) => Promise<void>): ForgeProvider {
  return selection.adapter.create({ repo: selection.repo, token: selection.token, http, sleep })
}
