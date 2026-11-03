import type { EngineInterface, Register } from 'claude-code'
import { backToMain, backgroundTreesRoot, listAgents, openReview, reviewButtons, type BackgroundMarker, type ReviewButton } from './background.ts'

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

    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const { buttons, back } = await readReviews($)
    const reviews = buttons.slice(0, MAX_REVIEW_BUTTONS).flatMap(button => [
      h(Text, null, ' '),
      h(Button, { key: `${REVIEW_PREFIX}${button.pr}`, onPress: () => undefined }, h(Text, button.color ? { color: button.color } : null, `PR-${button.pr}`), ' !'),
    ])
    return h(Box, null, below, h(Text, null, ' '), h(Button, { key: PR_BUTTON, label: 'PR', hotkey: 'r', onPress: () => undefined }), ...reviews,
      ...(back ? [h(Text, null, ' '), h(Button, { key: BACK_BUTTON, label: '← назад', hotkey: 'b', onPress: () => undefined })] : []))
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
    else if (e.element === BACK_BUTTON && back) void backToMain($, back).then(async done => { if (done) await $.state.set(REVIEWS, { buttons: (await readReviews($)).buttons }) })
    else return next(e)
    return { element: e.element }
  }).catch(($, e, next) => next(e))
}
