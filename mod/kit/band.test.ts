import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EngineInterface } from 'claude-code'
import { pollOnce, readReviews, registerBand } from './band.ts'
import { activeRun } from './state.ts'
import { fakeEngine } from '../testing/engine.ts'
import { repo } from '../testing/repo.ts'

interface Node { tag: string; props: Record<string, unknown> | null; children: unknown[] }
type Hook = (...args: unknown[]) => Promise<unknown>

const tag = (name: string) => Object.assign(() => null, { tagName: name })
const BELOW = { tag: 'below' }

Object.assign(globalThis, {
  h: (t: { tagName: string }, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({ tag: t.tagName, props, children }),
})

function setup(run: (input: unknown) => Promise<unknown> = async () => undefined, reviews?: unknown) {
  const hooks: Record<string, Array<{ matcher: unknown; hook: Hook }>> = {}
  const runs: unknown[] = []
  const toasts: string[] = []
  const claudeCalls: string[][] = []
  const submitted: string[] = []
  const state = new Map<string, unknown>(reviews ? [[JSON.stringify({ plugin: 'review-kit', key: 'reviews' }), reviews]] : [])
  registerBand(((event: string, matcher: unknown, hook: Hook) => {
    (hooks[event] ??= []).push({ matcher, hook })
    return { catch: () => undefined }
  }) as never)
  const $ = {
    ui: { resolve: () => ({ Box: tag('Box'), Button: tag('Button'), Text: tag('Text') }), toast: (text: string) => { toasts.push(text) }, log: () => undefined },
    command: { run: async (input: unknown) => { runs.push(input); return run(input) } },
    state: { get: async (key: unknown) => ({ value: state.get(JSON.stringify(key)) }), set: async (key: unknown, value: unknown) => { state.set(JSON.stringify(key), value) } },
    process: { run: async (argv: string[]) => { claudeCalls.push(argv); return stopResult } },
    prompt: { submit: async ({ text }: { text: string }) => { submitted.push(text) } },
    clock: { after: (_ms: number, fn: () => void) => fn() },
    session: { root: async () => '/tmp/none' },
  }
  let stopResult = { exitCode: 0, stdout: '', stderr: '' }
  const render = (hasSurvey: boolean) => hooks['ui.render'][0].hook($, { props: { hasSurvey } }, async () => BELOW)
  const pressOn = async (element: string) => {
    for (const { matcher, hook } of hooks['ui.press']) {
      const m = matcher as { element?: string }
      if (m.element !== undefined && m.element !== element) continue
      const answer = await hook($, { plugin: 'review-kit', element }, async () => ({ element: 'next' }))
      await new Promise(resolve => setImmediate(resolve))
      if ((answer as { element: string }).element !== 'next') return answer
    }
    return { element: 'next' }
  }
  const press = () => pressOn('pr')
  return { hooks, render, press, pressOn, runs, toasts, claudeCalls, submitted, failStop: () => { stopResult = { exitCode: 1, stdout: '', stderr: 'no such agent' } } }
}

test('полоса: нажатие ловит хук ui.press своей кнопки', () => {
  const { hooks } = setup()
  assert.deepEqual(hooks['ui.press'][0].matcher, { plugin: 'review-kit', element: 'pr' })
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

const REVIEWS = { buttons: [{ pr: 7, id: 'id7', sessionId: 'sid7', color: 'red' }, { pr: 9, id: 'id9', sessionId: 'sid9', color: 'green' }] }

test('полоса: законченные фоновые ревью — кнопки PR-N с цветом вердикта и «!», без хоткеев', async () => {
  const { render } = setup(undefined, REVIEWS)
  const tree = (await render(false)) as Node
  const buttons = tree.children.filter(child => (child as Node).tag === 'Button') as Node[]
  assert.deepEqual(buttons.map(b => [b.props?.key, b.props?.hotkey]), [['pr', 'r'], ['review:7', undefined], ['review:9', undefined]])
  const red = buttons[1].children[0] as Node
  assert.deepEqual([red.tag, red.props?.color, red.children], ['Text', 'red', ['PR-7']])
  assert.equal(buttons[1].children.at(-1), ' !')
})

test('полоса: без фоновых ревью — одна кнопка PR', async () => {
  const { render } = setup(undefined, { buttons: [] })
  const tree = (await render(false)) as Node
  assert.deepEqual(tree.children.filter(child => (child as Node).tag === 'Button').map(b => (b as Node).props?.key), ['pr'])
})

test('полоса: «← назад» — когда в состоянии есть основная сессия', async () => {
  const tree = (await setup(undefined, { buttons: [], back: { pr: 7, mainSessionId: 'main-id' } }).render(false)) as Node
  const back = (tree.children as Node[]).find(child => child.props?.key === 'back')
  assert.deepEqual([back?.props?.label, back?.props?.hotkey], ['← назад', 'b'])
  const plain = (await setup(undefined, { buttons: [] }).render(false)) as Node
  assert.equal((plain.children as Node[]).some(child => child.props?.key === 'back'), false)
})

function markedTree(r: ReturnType<typeof repo>, pr: number): string {
  const tree = join(r.dir, `.claude/worktrees/pr-${pr}-feat`)
  mkdirSync(join(tree, '.review-kit'), { recursive: true })
  writeFileSync(join(tree, '.review-kit/background.json'), JSON.stringify({ pr, mainSessionId: 'main-id' }))
  mkdirSync(join(tree, `.review-kit/run/${pr}`), { recursive: true })
  writeFileSync(join(tree, `.review-kit/run/${pr}/result.json`), JSON.stringify({ verdict: 'comments', blocking: 0, nonBlocking: 1 }))
  return tree
}

test('опрос: меток фоновых деревьев нет — claude не вызывается', async () => {
  const r = repo(); r.commit('a.txt', '1', 'base')
  const calls: string[][] = []
  const { $, invalidated } = fakeEngine({ root: r.dir, claude: argv => { calls.push(argv); return { exitCode: 0, stdout: '[]', stderr: '' } } })
  await pollOnce($)
  assert.deepEqual(calls, [])
  assert.deepEqual(invalidated, [])
})

test('опрос: claude agents вернул мусор — кнопок нет, перерисовки нет, исключения нет', async () => {
  const r = repo(); r.commit('a.txt', '1', 'base'); markedTree(r, 7)
  const { $, invalidated } = fakeEngine({ root: r.dir, claude: () => ({ exitCode: 0, stdout: 'oops', stderr: '' }) })
  await pollOnce($)
  assert.deepEqual(await readReviews($), { buttons: [] })
  assert.deepEqual(invalidated, [])
})

test('опрос: законченное ревью ждёт решения — кнопка в состоянии и перерисовка; повтор без изменений — без перерисовки', async () => {
  const r = repo(); r.commit('a.txt', '1', 'base')
  const tree = markedTree(r, 7)
  const sessions = [{ id: 'id7', sessionId: 'sid7', name: 'PR-7', cwd: tree, kind: 'background', status: 'waiting', waitingFor: 'input needed', state: 'blocked' }]
  const { $, invalidated } = fakeEngine({ root: r.dir, claude: () => ({ exitCode: 0, stdout: JSON.stringify(sessions), stderr: '' }) })
  await pollOnce($)
  assert.deepEqual((await readReviews($)).buttons, [{ pr: 7, id: 'id7', sessionId: 'sid7', color: 'yellow' }])
  await pollOnce($)
  assert.deepEqual(invalidated, ['ui.render'])
})

function resumedTree({ stop = 0, resume }: { stop?: number; resume?: (input: { command: string; args?: string }) => Promise<unknown> } = {}) {
  const r = repo(); r.commit('a.txt', '1', 'base')
  mkdirSync(join(r.dir, '.review-kit/run/7'), { recursive: true })
  writeFileSync(join(r.dir, '.review-kit/run/7/context.json'), JSON.stringify({ number: 7, isOwn: false, state: 'open', head: 'abc', base: 'def', scenario: 'review' }))
  writeFileSync(join(r.dir, '.review-kit/run/7/session.json'), JSON.stringify({ sessionId: 'background-session', status: 'active' }))
  const calls: string[][] = []
  const session = { id: 'test-session' }
  const engine = fakeEngine({ root: r.dir, claude: argv => { calls.push(argv); return { exitCode: stop, stdout: '', stderr: '' } }, command: resume ?? (async input => { if (input.command === 'resume') session.id = input.args ?? ''; return { text: '' } }) })
  Object.assign(engine.$.session, { id: async () => session.id })
  const hooks: Array<{ matcher: { element?: string }; hook: Hook }> = []
  registerBand(((event: string, matcher: { element?: string }, hook: Hook) => {
    if (event === 'ui.press') hooks.push({ matcher, hook })
    return { catch: () => undefined }
  }) as never)
  const press = async (element: string) => {
    const hook = hooks.find(item => item.matcher.element === undefined)!.hook
    const answer = await hook(engine.$, { plugin: 'review-kit', element }, async () => ({ element: 'next' }))
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
    return answer
  }
  return { ...engine, r, calls, press }
}

async function withButtons($: EngineInterface, reviews: unknown) {
  await $.state.set({ plugin: 'review-kit', key: 'reviews' } as never, reviews as never)
}

test('нажатие PR-7: claude stop, /resume полного id, прогон поднят, «← назад» запомнен, вопрос публикации заново', async () => {
  const t = resumedTree()
  await withButtons(t.$, REVIEWS)
  assert.deepEqual(await t.press('review:7'), { element: 'review:7' })
  assert.deepEqual(t.calls, [['claude', 'stop', 'id7']])
  assert.deepEqual(t.commands, [{ command: 'resume', args: 'sid7' }, { command: 'rename', args: 'PR-7' }])
  assert.equal(await activeRun(t.$), 7)
  assert.equal(JSON.parse(readFileSync(join(t.r.dir, '.review-kit/run/7/session.json'), 'utf8')).sessionId, 'sid7')
  assert.deepEqual((await readReviews(t.$)).back, { pr: 7, mainSessionId: 'test-session' })
  assert.deepEqual(t.submitted, ['Use the review-kit:pr-publish-run skill for PR 7; context: .review-kit/run/7/context.json'])
  assert.deepEqual(t.toasts, [])
})

test('нажатие PR-7: stop не прошёл — resume не вызывается, тост с claude attach', async () => {
  const t = resumedTree({ stop: 1 })
  await withButtons(t.$, REVIEWS)
  await t.press('review:7')
  assert.deepEqual(t.commands, [])
  assert.deepEqual(t.submitted, [])
  assert.deepEqual(t.toasts, ['review-kit: не удалось остановить фоновое ревью PR 7 — открой его: claude attach PR-7'])
})

test('нажатие PR-7: resume бросил — тост с claude attach, прогон не тронут, вопрос не задаётся', async () => {
  const t = resumedTree({ resume: async () => { throw new Error('busy') } })
  await withButtons(t.$, REVIEWS)
  await t.press('review:7')
  assert.deepEqual(t.submitted, [])
  assert.equal(await activeRun(t.$), undefined)
  assert.deepEqual(t.toasts, ['review-kit: не удалось открыть ревью PR 7 (Error: busy) — открой его: claude attach PR-7'])
})

test('нажатие PR-7: после resume файлов прогона нет — тост с /pr 7, вопрос не задаётся', async () => {
  const t = resumedTree()
  rmSync(join(t.r.dir, '.review-kit/run/7'), { recursive: true })
  await withButtons(t.$, REVIEWS)
  await t.press('review:7')
  assert.deepEqual(t.submitted, [])
  assert.match(t.toasts.join('\n'), /ревью PR 7 открыто, но прогон не поднят.*\/pr 7/)
})

test('«← назад»: /resume основной сессии, кнопка гаснет; сбой — тост с id', async () => {
  const t = resumedTree()
  await withButtons(t.$, { buttons: [], back: { pr: 7, mainSessionId: 'main-id' } })
  assert.deepEqual(await t.press('back'), { element: 'back' })
  assert.deepEqual(t.commands, [{ command: 'resume', args: 'main-id' }])
  assert.deepEqual(await readReviews(t.$), { buttons: [] })
  const failing = resumedTree({ resume: async () => { throw new Error('busy') } })
  await withButtons(failing.$, { buttons: [], back: { pr: 7, mainSessionId: 'main-id' } })
  await failing.press('back')
  assert.deepEqual(failing.toasts, ['review-kit: не удалось вернуться в основную сессию (Error: busy) — /resume main-id'])
  assert.deepEqual((await readReviews(failing.$)).back, { pr: 7, mainSessionId: 'main-id' })
})

test('нажатие PR-7: /resume не сменил сессию (не нашёл) — тост, прогон не тронут, вопрос не задаётся', async () => {
  const t = resumedTree({ resume: async () => ({ text: 'Session sid7 was not found.' }) })
  await withButtons(t.$, REVIEWS)
  await t.press('review:7')
  assert.equal(await activeRun(t.$), undefined)
  assert.deepEqual(t.submitted, [])
  assert.deepEqual(t.toasts, ['review-kit: не удалось открыть ревью PR 7 (сессия sid7 не открылась) — открой его: claude attach PR-7'])
})

test('«← назад»: после возврата запись законченной фоновой сессии с удалённым деревом убрана', async () => {
  const t = resumedTree()
  const agents = JSON.stringify([
    { id: 'id7', sessionId: 'sid7', name: 'PR-7', cwd: join(t.r.dir, '.claude/worktrees/pr-7-feat'), kind: 'background', status: null, state: 'stopped' },
    { id: 'id8', sessionId: 'sid8', name: 'PR-8', cwd: t.r.dir, kind: 'background', status: null, state: 'stopped' },
  ])
  const original = t.$.process.run
  Object.assign(t.$.process, { run: async (argv: string[], init?: never) => argv[0] === 'claude' && argv[1] === 'agents' ? (t.calls.push(argv), { exitCode: 0, stdout: agents, stderr: '' }) : original(argv, init) })
  await withButtons(t.$, { buttons: [], back: { pr: 7, mainSessionId: 'main-id' } })
  await t.press('back')
  assert.deepEqual(t.calls.filter(argv => argv[1] === 'rm'), [['claude', 'rm', 'id7']])
})

test('«← назад»: /resume не сменил сессию — тост, кнопка остаётся', async () => {
  const t = resumedTree({ resume: async () => ({ text: 'Session main-id was not found.' }) })
  await withButtons(t.$, { buttons: [], back: { pr: 7, mainSessionId: 'main-id' } })
  await t.press('back')
  assert.deepEqual(t.toasts, ['review-kit: не удалось вернуться в основную сессию (сессия main-id не открылась) — /resume main-id'])
  assert.deepEqual((await readReviews(t.$)).back, { pr: 7, mainSessionId: 'main-id' })
})

test('опрос: сессия с меткой вне деревьев этого проекта — кнопки нет', async () => {
  const r = repo(); r.commit('a.txt', '1', 'base'); markedTree(r, 7)
  const elsewhere = repo(); elsewhere.commit('a.txt', '1', 'base')
  const outside = markedTree(elsewhere, 8)
  const sessions = [{ id: 'id8', sessionId: 'sid8', name: 'PR-8', cwd: outside, kind: 'background', status: 'waiting', waitingFor: 'input needed', state: 'blocked' }]
  const { $ } = fakeEngine({ root: r.dir, claude: () => ({ exitCode: 0, stdout: JSON.stringify(sessions), stderr: '' }) })
  await pollOnce($)
  assert.deepEqual((await readReviews($)).buttons, [])
})

test('нажатие PR-7: /rename не прошёл — переход всё равно идёт, сбой в лог', async () => {
  const session = { id: 'test-session' }
  const t = resumedTree({ resume: async input => { if (input.command === 'rename') throw new Error('nope'); session.id = input.args ?? ''; return { text: '' } } })
  Object.assign(t.$.session, { id: async () => session.id })
  await withButtons(t.$, REVIEWS)
  await t.press('review:7')
  assert.equal(await activeRun(t.$), 7)
  assert.equal(t.submitted.length, 1)
  assert.match(t.logs.join('\n'), /\/rename не прошёл: Error: nope/)
})
