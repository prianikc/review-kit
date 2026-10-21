import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appliesTo, globMatch, importsOf, isRulePath, readRules, rulePaths, rulePatterns } from './rules.ts'
import { repo } from '../testing/repo.ts'

test('rulePaths: только Claude Code — CLAUDE.md вверх от изменённых файлов, .claude/CLAUDE.md, .claude/rules; чужие системы нет', () => {
  const tree = ['CLAUDE.md', 'src/CLAUDE.md', 'src/AGENTS.md', 'AGENTS.md', 'src/x/a.ts', 'lib/CLAUDE.md', '.claude/CLAUDE.md', '.claude/rules/ts.md', '.cursor/rules/a.mdc', '.github/copilot-instructions.md', 'docs/CLAUDE.md.bak']
  assert.deepEqual(rulePaths(tree, ['src/x/a.ts', 'new/dir/f.ts']), ['.claude/CLAUDE.md', '.claude/rules/ts.md', 'CLAUDE.md', 'src/CLAUDE.md'])
  assert.deepEqual(['CLAUDE.md', 'a/CLAUDE.md', '.claude/rules/x.md', 'AGENTS.md', '.cursor/rules/a.mdc'].map(isRulePath), [true, true, true, false, false])
})

test('rulePatterns: paths списком, строкой, в скобках; без frontmatter или без paths — null', () => {
  assert.deepEqual(rulePatterns('---\npaths:\n  - "src/**/*.ts"\n  - lib/*.js\ndescription: x\n---\nтекст'), ['src/**/*.ts', 'lib/*.js'])
  assert.deepEqual(rulePatterns("---\npaths: 'api/**'\n---\n"), ['api/**'])
  assert.deepEqual(rulePatterns('---\npaths: ["a/**", b/*.md]\n---\n'), ['a/**', 'b/*.md'])
  assert.equal(rulePatterns('---\ndescription: x\n---\nтекст'), null)
  assert.equal(rulePatterns('текст без frontmatter'), null)
})

test('globMatch: **, *, ?, {a,b}, ведущий ./', () => {
  assert.ok(globMatch('src/**/*.ts', 'src/a.ts'))
  assert.ok(globMatch('src/**/*.ts', 'src/x/y/a.ts'))
  assert.ok(!globMatch('src/**/*.ts', 'lib/a.ts'))
  assert.ok(globMatch('*.md', 'README.md'))
  assert.ok(!globMatch('*.md', 'docs/README.md'))
  assert.ok(globMatch('**/*.{ts,tsx}', 'a/b.tsx'))
  assert.ok(globMatch('./mod/?.ts', 'mod/a.ts'))
  assert.ok(globMatch('mod/**', 'mod/run/input.ts'))
})

test('appliesTo: без paths — всегда; с paths — если хоть один файл PR подходит', () => {
  assert.ok(appliesTo('общее правило', ['a.ts']))
  assert.ok(appliesTo('---\npaths:\n  - "mod/**"\n---\n', ['README.md', 'mod/a.ts']))
  assert.ok(!appliesTo('---\npaths:\n  - "mod/**"\n---\n', ['README.md']))
})

test('importsOf: @путь относительно файла, не в коде, без ~ и абсолютных, без хвостовой пунктуации', () => {
  const text = 'Смотри @AGENTS.md и @docs/style.md.\nпочта a@b.com\n`@skip.md` в коде\n```\n@also-skip.md\n```\n@~/home.md @/abs.md @../up.md'
  assert.deepEqual(importsOf(text, 'CLAUDE.md'), ['AGENTS.md', 'docs/style.md'])
  assert.deepEqual(importsOf('@../shared.md @./local.md', 'pkg/CLAUDE.md'), ['shared.md', 'pkg/local.md'])
})

test('readRules: с базы; правила с paths мимо PR не берутся; AGENTS.md — только по импорту, цепочкой; изменённые — в changedRules', async () => {
  const r = repo()
  r.commit('AGENTS.md', 'Общие соглашения: @docs/naming.md\n', 'agents')
  r.commit('docs/naming.md', 'Имена функций — глаголом.\n', 'naming')
  r.commit('.claude/rules/api.md', '---\npaths:\n  - "api/**"\n---\nAPI-правило\n', 'api rule')
  r.commit('.claude/rules/mod.md', '---\npaths: "mod/**"\n---\nПравило мода\n', 'mod rule')
  r.commit('.cursor/rules/x.mdc', 'Cursor\n', 'cursor')
  const base = r.commit('CLAUDE.md', 'Проект. @AGENTS.md\n', 'claude')
  r.commit('docs/naming.md', 'Как угодно.\n', 'pr ослабил импортированное правило')
  const head = r.commit('mod/a.ts', 'x\n', 'pr code')
  const { rules, changedRules } = await readRules(r.run, { rev: base, base, head })
  assert.deepEqual([...rules.keys()], ['.claude/rules/mod.md', 'AGENTS.md', 'CLAUDE.md', 'docs/naming.md'])
  assert.equal(rules.get('docs/naming.md'), 'Имена функций — глаголом.\n')
  assert.deepEqual(changedRules, ['docs/naming.md'])
})

test('readRules: без CLAUDE.md чужие AGENTS.md и .cursor не берутся', async () => {
  const r = repo()
  r.commit('AGENTS.md', 'правила\n', 'agents')
  const base = r.commit('.cursor/rules/x.mdc', 'Cursor\n', 'cursor')
  const head = r.commit('a.ts', 'x\n', 'code')
  assert.equal((await readRules(r.run, { rev: base, base, head })).rules.size, 0)
})
