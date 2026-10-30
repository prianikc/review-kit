export const meta = {
  name: 'review-kit-funnel',
  description: 'review-kit: агенты A/B ищут находки в PR, агент C пытается их опровергнуть',
  phases: [{ title: 'Поиск' }, { title: 'Опровержение' }],
}

if (!args?.manifestDir) throw new Error('review-kit: воронку запускает /pr N с подготовленным входом')

const FINDINGS = {
  "type": "object",
  "additionalProperties": false,
  "required": [
    "findings",
    "notChecked"
  ],
  "properties": {
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "file",
          "line",
          "severity",
          "confidence",
          "problem"
        ],
        "properties": {
          "id": {
            "type": "string"
          },
          "file": {
            "type": "string"
          },
          "line": {
            "type": "integer",
            "minimum": 1
          },
          "severity": {
            "enum": [
              "blocking",
              "non-blocking"
            ]
          },
          "category": {
            "enum": [
              "regression",
              "goal",
              "architecture",
              "security",
              "rule"
            ]
          },
          "confidence": {
            "type": "integer",
            "minimum": 0,
            "maximum": 100
          },
          "problem": {
            "type": "string",
            "minLength": 1
          },
          "failureScenario": {
            "type": "string"
          },
          "rule": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "file",
              "quote"
            ],
            "properties": {
              "file": {
                "type": "string"
              },
              "quote": {
                "type": "string"
              }
            }
          },
          "suggestion": {
            "type": "string"
          },
          "thread": {
            "type": "string"
          },
          "authorReply": {
            "type": "string"
          },
          "followUp": {
            "type": "string"
          }
        }
      }
    },
    "notChecked": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  }
}

const VERDICTS = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'verdict'],
        properties: {
          id: { type: 'string' },
          verdict: { enum: ['refuted', 'confirmed', 'cannot-refute', 'closed'] },
          thread: { type: 'string' },
          evidence: { type: 'string' },
          duplicateOf: { type: 'string' },
          severity: { enum: ['blocking', 'non-blocking'] },
          category: { enum: ['regression', 'goal', 'architecture', 'security', 'rule'] },
          confidence: { type: 'integer', minimum: 0, maximum: 100 },
        },
      },
    },
  },
}

const PREFIX = { correctness: 'A', quality: 'B' }
const LINE_WINDOW = 3

function header(role) {
  return [`review-kit-role: ${role}`, `PR: ${args.pr}`, `Манифест: ${args.manifestDir}/manifest-${role}.txt`, `Вход ревью: ${args.input}`].join('\n')
}

function tagged(role, answer) {
  return answer.findings.map((item, index) => ({ ...item, id: `${PREFIX[role]}-${index + 1}`, role }))
}

function grouped(findings) {
  const sorted = [...findings].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return sorted.reduce((groups, item) => {
    const last = groups.at(-1)?.at(-1)
    if (last && last.file === item.file && item.line - last.line <= LINE_WINDOW) groups.at(-1).push(item)
    else groups.push([item])
    return groups
  }, [])
}

function refuterPrompt(findings) {
  const groups = grouped(findings).map(group => group.map(({ role, severity, confidence, ...item }) => item))
  return `${header('refuter')}\nНиже — группы находок A/B (JSON, одна строка). Вердикт — по каждому id.\n${JSON.stringify(groups)}`
}

function refute(findings) {
  return agent(refuterPrompt(findings), { agentType: 'review-kit:refuter', schema: VERDICTS, label: 'C refuter', phase: 'Опровержение' })
}

phase('Поиск')
const answers = await parallel(args.roles.map(role => () =>
  agent(header(role), { agentType: `review-kit:${role}`, schema: FINDINGS, label: `${PREFIX[role]} ${role}`, phase: 'Поиск' })))
const failed = args.roles.filter((_, index) => !answers[index])
const findings = answers.flatMap((answer, index) => (answer ? tagged(args.roles[index], answer) : []))
const notChecked = [...new Set(answers.flatMap(answer => answer?.notChecked ?? []))]
if (findings.length === 0) return { findings, verdicts: [], refuter: 'skipped', failed, roles: args.roles, notChecked }

phase('Опровержение')
const verdict = (await refute(findings)) ?? (await refute(findings))
if (!verdict) log('review-kit: агент C не ответил дважды — все находки пойдут как «не удалось проверить»')
return { findings, verdicts: verdict?.verdicts ?? [], refuter: verdict ? 'ok' : 'failed', failed, roles: args.roles, notChecked }
