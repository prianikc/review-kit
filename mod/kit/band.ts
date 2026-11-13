import type { EngineInterface, Register } from 'claude-code'
import { backToMain, backgroundTreesRoot, dropFinishedSessions, listAgents, openReview, reviewButtons, type BackgroundMarker, type ReviewButton } from './background.ts'
import { projectRoot } from './engine.ts'
import { dropBackgroundTree } from './finish.ts'
import { mainRoot } from './worktrees.ts'

const PLUGIN = 'review-kit'
const PR_BUTTON = 'pr'
const REVIEW_PREFIX = 'review:'
const BACK_BUTTON = 'back'
const MAX_REVIEW_BUTTONS = 9
const AGENTS_POLL_MS = 15 * 1000
const REVIEWS = { plugin: 'review-kit', key: 'reviews' } as const
const POLL = { started: false }

type On = Parameters<Register>[0]

export interface Reviews {
  buttons: ReviewButton[]
  back?: BackgroundMarker
}

export async function readReviews($: EngineInterface): Promise<Reviews> {
  const value = (await $.state.get(REVIEWS)).value as Reviews | undefined
  return { buttons: value?.buttons ?? [], ...(value?.back ? { back: value.back } : {}) }
}

export async function pollOnce($: EngineInterface): Promise<void> {
  const trees = await backgroundTreesRoot($).catch(() => undefined)
  const sessions = trees ? (await listAgents($).catch(() => [])).filter(session => session.cwd.startsWith(trees)) : []
  const buttons = sessions.length ? await reviewButtons($, sessions).catch(() => []) : []
  const current = await readReviews($)
  if (JSON.stringify(current.buttons) === JSON.stringify(buttons)) return
  await $.state.set(REVIEWS, { ...current, buttons })
  $.ui.invalidate('ui.render')
}

export function startAgentsPoll($: EngineInterface): void {
  if (POLL.started) return
  POLL.started = true
  const tick = (): void => {
    void pollOnce($).catch(error => $.ui.log(`review-kit: опрос фоновых ревью не прошёл: ${String(error)}`)).finally(() => $.clock.after(AGENTS_POLL_MS, tick))
  }
  tick()
}

export function registerBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const { buttons, back } = await readReviews($)
    const reviews = buttons.slice(0, MAX_REVIEW_BUTTONS).flatMap(button => [
      h(Text, null, ' '),
      h(Button, { key: `${REVIEW_PREFIX}${button.pr}`, onPress: () => undefined }, h(Text, button.color ? { color: button.color } : null, `PR-${button.pr}`), ' !'),
    ])
    return h(Box, null, h(Button, { key: PR_BUTTON, label: 'PR', hotkey: 'r', onPress: () => undefined }), ...reviews,
      ...(back ? [h(Text, null, ' '), h(Button, { key: BACK_BUTTON, label: '← назад', hotkey: 'b', onPress: () => undefined })] : []))
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePromptList' }, ($, e, next) => {
    const own = e.props.rows.filter(row => row.plugin === PLUGIN)
    return own.length ? next({ ...e, props: { ...e.props, rows: [...e.props.rows.filter(row => row.plugin !== PLUGIN), ...own] } }) : next(e)
  }).catch(($, e, next) => next(e))

  on('ui.press', { plugin: 'review-kit', element: PR_BUTTON }, ($, e) => {
    void $.command.run({ command: 'pr' }).catch(error => $.ui.toast(`review-kit: /pr не запустился: ${String(error)}`))
    return { element: e.element }
  }).catch(($, e, next) => next(e))

  on('ui.press', { plugin: 'review-kit' }, async ($, e, next) => {
    const { buttons, back } = await readReviews($)
    const button = e.element.startsWith(REVIEW_PREFIX) ? buttons.find(item => `${REVIEW_PREFIX}${item.pr}` === e.element) : undefined
    if (button) void openReview($, button).then(async opened => { if (opened) await $.state.set(REVIEWS, { ...(await readReviews($)), back: opened }) })
      .catch(error => $.ui.toast(`review-kit: ревью PR ${button.pr} не открылось: ${String(error)}`))
    else if (e.element === BACK_BUTTON && back) {
      const [tree, main] = await Promise.all([projectRoot($), mainRoot($)]).catch(() => [undefined, undefined])
      void backToMain($, back).then(async done => {
        if (!done) return
        await $.state.set(REVIEWS, { buttons: (await readReviews($)).buttons })
        if (tree) await dropBackgroundTree($, tree).catch(error => $.ui.log(`review-kit: дерево фонового ревью не убрано: ${String(error)}`))
        if (main) await dropFinishedSessions($, main).catch(error => $.ui.log(`review-kit: фоновые сессии не убраны: ${String(error)}`))
      })
    }
    else return next(e)
    return { element: e.element }
  }).catch(($, e, next) => next(e))
}
