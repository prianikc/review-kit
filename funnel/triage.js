export const meta = {
  name: 'review-kit-triage',
  description: 'review-kit: агент D разбирает замечания к своему PR',
  phases: [{ title: 'Разбор' }],
}

if (!args?.manifestDir) throw new Error('review-kit: разбор запускает /pr N feedback с подготовленным входом')

const TRIAGE = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'class', 'reason'],
        properties: {
          id: { type: 'string' },
          class: { enum: ['valid', 'todo', 'invalid', 'question', 'out-of-scope'] },
          reason: { type: 'string', minLength: 1 },
          evidence: { type: 'string' },
          fixed: { type: 'boolean' },
        },
      },
    },
  },
}

const header = [`review-kit-role: triage`, `PR: ${args.pr}`, `Манифест: ${args.manifestDir}/manifest-triage.txt`, `Вход: ${args.input}`].join('\n')
phase('Разбор')
const answer = await agent(`${header}\n\nРазбери каждый пункт раздела ITEMS входа по своей инструкции.`, { agentType: 'review-kit:triage', schema: TRIAGE, label: 'D triage', phase: 'Разбор' }).catch(() => null)
return answer ?? { items: [] }
