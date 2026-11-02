import type { Register } from 'claude-code'

type On = Parameters<Register>[0]

export function registerBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const runPr = () => {
      void $.command.run({ command: 'pr' }).catch(error => $.ui.toast(`review-kit: /pr не запустился: ${String(error)}`))
    }

    return h(Box, null, below, h(Text, null, ' '), h(Button, { key: 'pr', label: 'PR', hotkey: 'r', onPress: runPr }))
  }).catch(($, e, next) => next(e))
}
