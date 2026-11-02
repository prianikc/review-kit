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
  const hooks: Record<string, { matcher: unknown; hook: Hook }> = {}
  const runs: unknown[] = []
  const toasts: string[] = []
  registerBand(((event: string, matcher: unknown, hook: Hook) => {
    hooks[event] = { matcher, hook }
    return { catch: () => undefined }
  }) as never)
  const $ = {
    ui: { resolve: () => ({ Box: tag('Box'), Button: tag('Button'), Text: tag('Text') }), toast: (text: string) => { toasts.push(text) } },
    command: { run: async (input: unknown) => { runs.push(input); return run(input) } },
  }
  const render = (hasSurvey: boolean) => hooks['ui.render'].hook($, { props: { hasSurvey } }, async () => BELOW)
  const press = async () => {
    const answer = await hooks['ui.press'].hook($, { plugin: 'review-kit', element: 'pr' }, async () => ({ element: 'pr' }))
    await new Promise(resolve => setImmediate(resolve))
    return answer
  }
  return { hooks, render, press, runs, toasts }
}

test('полоса: нажатие ловит хук ui.press своей кнопки', () => {
  const { hooks } = setup()
  assert.deepEqual(hooks['ui.press'].matcher, { plugin: 'review-kit', element: 'pr' })
})

test('полоса: кнопка PR справа от того, что рисуют другие плагины', async () => {
  const { render } = setup()
  const tree = (await render(false)) as Node
  assert.equal(tree.tag, 'Box')
  assert.equal(tree.children[0], BELOW)
  const button = tree.children.at(-1) as Node
  assert.equal(button.tag, 'Button')
  assert.deepEqual({ key: button.props?.key, label: button.props?.label, hotkey: button.props?.hotkey }, { key: 'pr', label: 'PR', hotkey: 'r' })
  assert.equal(typeof button.props?.onPress, 'function')
})

test('полоса: нажатие запускает /pr и забирает его', async () => {
  const { press, runs, toasts } = setup()
  assert.deepEqual(await press(), { element: 'pr' })
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
