import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerBand } from './band.ts'

interface Node { tag: string; props: Record<string, unknown> | null; children: unknown[] }
type Hook = (...args: unknown[]) => Promise<unknown>

const tag = (name: string) => Object.assign(() => null, { tagName: name })
const BELOW = { tag: 'below' }

Object.assign(globalThis, {
  h: (t: { tagName: string }, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({ tag: t.tagName, props, children }),
})

function setup(run: (input: unknown) => Promise<unknown> = async () => undefined) {
  const hooks: Hook[] = []
  const runs: unknown[] = []
  const toasts: string[] = []
  registerBand(((_event: string, _matcher: unknown, hook: Hook) => {
    hooks.push(hook)
    return { catch: () => undefined }
  }) as never)
  const $ = {
    ui: { resolve: () => ({ Box: tag('Box'), Button: tag('Button'), Text: tag('Text') }), toast: (text: string) => { toasts.push(text) } },
    command: { run: async (input: unknown) => { runs.push(input); return run(input) } },
  }
  const render = (hasSurvey: boolean) => hooks[0]($, { props: { hasSurvey } }, async () => BELOW)
  const press = async () => {
    const tree = (await render(false)) as Node
    ;((tree.children.at(-1) as Node).props?.onPress as () => void)()
    await new Promise(resolve => setImmediate(resolve))
  }
  return { render, press, runs, toasts }
}

test('полоса: кнопка PR справа от того, что рисуют другие плагины', async () => {
  const { render } = setup()
  const tree = (await render(false)) as Node
  assert.equal(tree.tag, 'Box')
  assert.equal(tree.children[0], BELOW)
  const button = tree.children.at(-1) as Node
  assert.equal(button.tag, 'Button')
  assert.deepEqual({ key: button.props?.key, label: button.props?.label, hotkey: button.props?.hotkey }, { key: 'pr', label: 'PR', hotkey: 'r' })
})

test('полоса: нажатие запускает /pr', async () => {
  const { press, runs, toasts } = setup()
  await press()
  assert.deepEqual(runs, [{ command: 'pr' }])
  assert.deepEqual(toasts, [])
})

test('полоса: /pr не запустился — тост', async () => {
  const { press, toasts } = setup(async () => { throw new Error('busy') })
  await press()
  assert.deepEqual(toasts, ['review-kit: /pr не запустился: Error: busy'])
})

test('полоса: при опросе отдаёт полосу ниже без изменений', async () => {
  const { render } = setup()
  assert.equal(await render(true), BELOW)
})
