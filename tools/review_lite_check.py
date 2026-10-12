import argparse, json, re, subprocess, sys, unicodedata

from review_lite_input import MAX_FILE_CHARS, InputError, changed_files, file_states, not_attached, read_rules

MIN_QUOTE_WORDS = 6
MIN_QUOTE_CHARS = 30
SEVERITIES = ('critical', 'important', 'minor')
FINDING_REQUIRED = ('id', 'file', 'line', 'severity', 'confidence', 'problem')
FINDING_FIELDS = set(FINDING_REQUIRED) | {'failureScenario', 'rule', 'suggestion'}


def schema_errors(doc: object) -> list[str]:
    if not isinstance(doc, dict):
        return ['ответ — не объект']

    errors = [f'лишнее поле верхнего уровня: {key}' for key in doc if key not in ('findings', 'notChecked')]
    if not isinstance(doc.get('notChecked'), list) or not all(isinstance(x, str) for x in doc.get('notChecked', [None])):
        errors.append('notChecked — нужен массив строк')
    if not isinstance(doc.get('findings'), list):
        return errors + ['findings — нужен массив']

    for index, item in enumerate(doc['findings']):
        errors += [f'findings[{index}].{e}' for e in finding_errors(item)]

    ids = [item.get('id') for item in doc['findings'] if isinstance(item, dict)]
    errors += [f'id {value} повторяется' for value in sorted({i for i in ids if ids.count(i) > 1}, key=str)]

    return errors


def finding_errors(item: object) -> list[str]:
    if not isinstance(item, dict):
        return ['не объект']

    errors = [f'{key}: обязательное поле' for key in FINDING_REQUIRED if key not in item]
    errors += [f'{key}: лишнее поле' for key in item if key not in FINDING_FIELDS]
    errors += [f'{key}: строка' for key in ('failureScenario', 'suggestion') if key in item and not isinstance(item[key], str)]
    if not isinstance(item.get('line'), int) or item.get('line', 0) < 1:
        errors.append('line: целое ≥ 1')
    if item.get('severity') not in SEVERITIES:
        errors.append(f'severity: одно из {SEVERITIES}')
    if not isinstance(item.get('confidence'), int) or not 0 <= item.get('confidence', -1) <= 100:
        errors.append('confidence: целое 0–100')
    if not isinstance(item.get('problem'), str) or not item.get('problem', '').strip():
        errors.append('problem: непустая строка')
    rule = item.get('rule')
    if rule is not None and not (isinstance(rule, dict) and set(rule) == {'file', 'quote'} and all(isinstance(v, str) for v in rule.values())):
        errors.append('rule: объект {file, quote} со строками')

    return errors


LIST_MARKER = re.compile(r'^\s*(?:[-*+>]|\d+\.)\s+', re.M)
MARKDOWN_LINK = re.compile(r'\[([^\]]*)\]\([^)]*\)')
TYPOGRAPHY = str.maketrans({'\u2014': '-', '\u2013': '-', '\u00ab': '"', '\u00bb': '"', '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u0451': '\u0435', '\u0401': '\u0415'})


def normalize(text: str) -> str:
    text = MARKDOWN_LINK.sub(r'\1', unicodedata.normalize('NFKC', text))
    text = LIST_MARKER.sub('', text).replace('|', ' ').translate(TYPOGRAPHY)
    return re.sub(r'\s+', ' ', re.sub(r'[*`_]', '', text)).strip()


def resolve_path(path: str, known: list[str]) -> str | None:
    cleaned = path.removeprefix('./')
    if cleaned in known:
        return cleaned

    return max((k for k in known if cleaned.endswith('/' + k)), key=len, default=None)


def location_reason(item: dict, changed: list[str], line_counts: dict[str, int]) -> str | None:
    file = resolve_path(item['file'], changed)
    if file is None:
        return 'file-not-in-diff'
    if file not in line_counts:
        return 'file-not-text'

    return 'line-out-of-range' if item['line'] > line_counts[file] else None


def rule_reason(rule: dict, rules: dict[str, str]) -> str | None:
    rule_file = resolve_path(rule['file'], list(rules))
    if rule_file is None:
        return 'rule-file-not-provided'
    quote = normalize(rule['quote'])
    if len(quote.split()) < MIN_QUOTE_WORDS or len(quote) < MIN_QUOTE_CHARS:
        return 'quote-too-short'

    pattern = r'(?<!\w)' + re.escape(quote) + r'(?!\w)'
    return None if re.search(pattern, normalize(rules[rule_file])) else 'quote-not-found'


def has_scenario(item: dict) -> bool:
    return bool(item.get('failureScenario', '').strip())


def checked_item(item: dict, rules: dict[str, str], changed: list[str], line_counts: dict[str, int]) -> tuple[dict | None, str | None]:
    location = location_reason(item, changed, line_counts)
    if location:
        return None, location

    result = {**item, 'file': resolve_path(item['file'], changed)}
    rule = item.get('rule')
    if not rule:
        return (result, None) if has_scenario(item) else (None, 'no-evidence')

    problem = rule_reason(rule, rules)
    if problem is None:
        return {**result, 'rule': {**rule, 'file': resolve_path(rule['file'], list(rules))}}, None
    if not has_scenario(item):
        return None, problem

    without_rule = {key: value for key, value in result.items() if key != 'rule'}
    return {**without_rule, 'ruleDropped': problem}, None


def with_skipped(not_checked: list[str], skipped: dict[str, str]) -> list[str]:
    extra = [f'{path} — не приложен: {reason}' for path, reason in skipped.items() if not any(path in entry for entry in not_checked)]
    return not_checked + extra


def check(doc: dict, rules: dict[str, str], changed: list[str], line_counts: dict[str, int], skipped: dict[str, str] | None = None) -> dict:
    kept, dropped = [], []

    for item in doc['findings']:
        result, reason = checked_item(item, rules, changed, line_counts)
        if result is None:
            dropped.append({'id': item['id'], 'reason': reason})
        else:
            kept.append(result)

    return {'findings': kept, 'notChecked': with_skipped(doc['notChecked'], skipped or {}), 'dropped': dropped}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--answer', required=True)
    parser.add_argument('--repo', default='.')
    parser.add_argument('--base', required=True)
    parser.add_argument('--head', required=True)
    parser.add_argument('--rules', nargs='+', required=True)
    parser.add_argument('--rules-rev')
    args = parser.parse_args()

    doc = json.load(open(args.answer, encoding='utf-8'))
    errors = schema_errors(doc)
    if errors:
        sys.stderr.write('\n'.join(errors) + '\n')
        sys.exit(2)

    try:
        rules = read_rules(args.repo, args.rules_rev or args.head, args.rules)
        changed = changed_files(args.repo, args.base, args.head)
        states = file_states(args.repo, args.base, args.head)
    except InputError as error:
        sys.stderr.write(f'review_lite_check: {error}\n')
        sys.exit(4)
    except subprocess.CalledProcessError as error:
        sys.stderr.write(f'review_lite_check: ревизия или путь не найдены: {" ".join(error.cmd[3:])}\n')
        sys.exit(2)
    line_counts = {path: len(text.splitlines()) for path, (text, _) in states.items() if text is not None}
    result = check(doc, rules, changed, line_counts, not_attached(states, MAX_FILE_CHARS))
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
