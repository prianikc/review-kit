import type { Register } from 'claude-code'

const PR_BUTTON = 'pr'

type On = Parameters<Register>[0]

export function registerBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return h(Box, null, below, h(Text, null, ' '), h(Button, { key: PR_BUTTON, label: 'PR', hotkey: 'r', onPress: () => undefined }))
  }).catch(($, e, next) => next(e))

  on('ui.press', { plugin: 'review-kit', element: PR_BUTTON }, ($, e) => {
    void $.command.run({ command: 'pr' }).catch(error => $.ui.toast(`review-kit: /pr не запустился: ${String(error)}`))
    return { element: e.element }
  }).catch(($, e, next) => next(e))
}
