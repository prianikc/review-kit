import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProvider, selectProvider, withTimeout } from './index.ts'
import type { ForgeAdapter } from './types.ts'

const adapter = (id: string, host: string, tokenEnv = [`${id.toUpperCase()}_TOKEN`]): ForgeAdapter => ({
  id, name: id.toUpperCase(), tokenEnv,
  detect: url => (url.includes(host) ? { host, owner: 'team', repo: 'app' } : null),
  create: deps => ({ name: id, capabilities: { inline: true, requestChanges: true }, currentUser: async () => deps.token } as never),
})
const ALPHA = adapter('alpha', 'a.example', ['ALPHA_TOKEN', 'OLD_ALPHA_TOKEN'])
const BETA = adapter('beta', 'b.example')
const env = (values: Record<string, string>) => (name: string) => values[name]
const base = { options: {}, remoteUrl: 'git@a.example:team/app.git', env: env({ ALPHA_TOKEN: 't' }), adapters: [ALPHA, BETA] }

test('по remote среди включённых; галочка по умолчанию включена', () => {
  assert.deepEqual(selectProvider(base), { adapter: ALPHA, repo: { host: 'a.example', owner: 'team', repo: 'app' }, token: 't' })
})

test('токен — из второй переменной, если первой нет', () => {
  const selection = selectProvider({ ...base, env: env({ OLD_ALPHA_TOKEN: 'old' }) })
  assert.equal('token' in selection && selection.token, 'old')
})

test('нет токена — какую переменную задать', () => {
  assert.deepEqual(selectProvider({ ...base, env: env({}) }), { error: 'Нет токена ALPHA: задайте переменную ALPHA_TOKEN или OLD_ALPHA_TOKEN в окружении терминала.' })
})

test('выключенная галочка — адаптер не участвует', () => {
  const selection = selectProvider({ ...base, options: { alpha: false } })
  assert.match('error' in selection ? selection.error : '', /не распознан.*включены: BETA/)
})

test('все выключены и явной настройки нет', () => {
  assert.deepEqual(selectProvider({ ...base, options: { alpha: false, beta: false } }), { error: 'Все системы выключены — включите нужную в настройках плагина (/plugin → review-kit → Configure options).' })
})

test('явная настройка побеждает галочку и remote', () => {
  const selection = selectProvider({ ...base, options: { alpha: false }, remoteUrl: 'git@other:x/y.git', config: { provider: 'alpha', host: 'h', owner: 'o', repo: 'r' } })
  assert.deepEqual(selection, { adapter: ALPHA, repo: { host: 'h', owner: 'o', repo: 'r' }, token: 't' })
})

test('явный provider без host/owner/repo — repo из remote этого адаптера', () => {
  const selection = selectProvider({ ...base, config: { provider: 'alpha' } })
  assert.deepEqual('repo' in selection && selection.repo, { host: 'a.example', owner: 'team', repo: 'app' })
})

test('явный provider, но remote не его и host/owner/repo нет', () => {
  const selection = selectProvider({ ...base, remoteUrl: 'git@other:x/y.git', config: { provider: 'alpha' } })
  assert.match('error' in selection ? selection.error : '', /укажите host, owner и repo/)
})

test('неизвестный provider в настройке', () => {
  assert.deepEqual(selectProvider({ ...base, config: { provider: 'gamma' } }), { error: 'В настройках review-kit указана неизвестная система «gamma»; есть: alpha, beta.' })
})

test('нет origin', () => {
  const selection = selectProvider({ ...base, remoteUrl: '' })
  assert.match('error' in selection ? selection.error : '', /remote origin не найден/)
})

test('createProvider передаёт репозиторий и токен адаптеру', async () => {
  const selection = selectProvider(base)
  if ('error' in selection) throw new Error(selection.error)
  const provider = createProvider(selection, async () => { throw new Error('no http') }, async () => {})
  assert.equal(await provider.currentUser(), 't')
})

test('реестр по умолчанию узнаёт Forgejo', () => {
  const selection = selectProvider({ options: {}, remoteUrl: 'git@git.example.org:team/app.git', env: env({ FORGEJO_TOKEN: 'f' }) })
  assert.equal('adapter' in selection && selection.adapter.id, 'forgejo')
})

test('withTimeout: нет ответа за отведённое время — ошибка', async () => {
  const never = () => new Promise<never>(() => {})
  const http = withTimeout(never, async () => {}, 30_000)
  await assert.rejects(http('https://x'), /нет ответа за 30 с/)
})

test('withTimeout: ответ успел — отдаётся как есть', async () => {
  const response = { status: 200, ok: true, headers: {}, text: 'ok' }
  const http = withTimeout(async () => response, () => new Promise<void>(() => {}), 30_000)
  assert.equal(await http('https://x'), response)
})

