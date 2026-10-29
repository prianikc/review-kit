import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { EngineInterface } from 'claude-code'

const PLUGIN_ROOT = join(import.meta.dirname, '..', '..')

export function fakeEngine({ root, answers = [], env = {} }: { root: string; answers?: string[]; env?: Record<string, string> }): { $: EngineInterface; asked: string[]; submitted: string[]; logs: string[] } {
  const asked: string[] = []
  const submitted: string[] = []
  const logs: string[] = []
  const state = new Map<string, unknown>()
  const queue = [...answers]
  const $ = {
    fs: {
      read: async (path: string) => readFileSync(path, 'utf8'),
      write: async (path: string, text: string) => {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, text)
      },
    },
    process: {
      run: async (argv: string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string }) => {
        const result = spawnSync(argv[0], argv.slice(1), { cwd: init?.cwd ?? root, env: { ...process.env, ...init?.env }, input: init?.stdin, encoding: 'utf8' })
        return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? (result.error ? String(result.error) : '') }
      },
      spawn: () => {
        throw new Error('process.spawn в фейковом движке не поддерживается')
      },
    },
    ui: {
      ask: async (question: string) => {
        asked.push(question)
        if (queue.length === 0) throw new Error(`неожиданный вопрос: ${question}`)
        return queue.shift() as string
      },
      log: (text: string) => {
        logs.push(text)
      },
    },
    state: {
      get: async (key: unknown) => ({ value: state.get(JSON.stringify(key)) }),
      set: async (key: unknown, value: unknown) => {
        state.set(JSON.stringify(key), value)
      },
    },
    session: { root: async () => root, id: async () => 'test-session' },
    clock: {
      sleep: async () => undefined,
      after: (_ms: number, fn: () => void) => fn(),
    },
    prompt: {
      submit: async ({ text }: { text: string }) => {
        submitted.push(text)
      },
    },
    env: { get: async (name: string) => env[name] },
    http: {
      fetch: async () => {
        throw new Error('http.fetch в фейковом движке не поддерживается')
      },
    },
    plugin: { root: PLUGIN_ROOT },
  }
  return { $: $ as unknown as EngineInterface, asked, submitted, logs }
}
