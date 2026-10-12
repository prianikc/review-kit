import argparse, glob, json, os, re, sys

from review_lite_check import checked_item
from review_lite_input import MAX_FILE_CHARS, changed_files, file_states, not_attached

VERDICTS = ('refuted', 'confirmed', 'cannot-refute')
RULE_PREFIXES = ('AGENTS.md', 'CLAUDE.md', '.claude/rules/', '.claude/ai-dev-kit/rules/', '.agents/skills/')
GATE_FAILURES = ('exhausted', 'stopped', 'hook-error', 'no-manifest')
EVIDENCE = re.compile(r'(?:^|[\s(`"\'])([\w./@-]+):(\d+)(?:-\d+)?')
INCOMPLETE = 6
SEVERITY_RANK = {'critical': 3, 'important': 2, 'minor': 1}


def same_file(path: str, file: str) -> bool:
    cleaned = path.removeprefix('./')
    return cleaned == file or file.endswith('/' + cleaned) or cleaned.endswith('/' + file)


def evidence_line(evidence: str, file: str) -> int | None:
    match = EVIDENCE.search(evidence or '')
    return int(match.group(2)) if match and same_file(match.group(1), file) else None


def cites_own_file(evidence: str, file: str) -> bool:
    return evidence_line(evidence, file) is not None


def with_evidence_line(item: dict, line_counts: dict[str, int]) -> dict:
    line = evidence_line(item.get('evidence', ''), item['file']) if item['verdict'] == 'confirmed' else None
    if line is None or not 1 <= line <= line_counts.get(item['file'], 0):
        return item

    return {**item, 'line': line, 'lines': [line]}


def verdict_of(item: dict, verdict: dict | None) -> dict:
    if not verdict or verdict.get('verdict') not in VERDICTS:
        return {**item, 'verdict': 'cannot-refute'}
    if verdict['verdict'] == 'refuted':
        evidence = verdict.get('evidence', '')
        return {**item, 'verdict': 'refuted', 'evidence': evidence} if cites_own_file(evidence, item['file']) else {**item, 'verdict': 'cannot-refute'}
    if verdict['verdict'] == 'confirmed':
        evidence = {'evidence': verdict['evidence']} if verdict.get('evidence') else {}
        return {**item, 'verdict': 'confirmed', 'severity': verdict.get('severity', item['severity']), 'confidence': verdict.get('confidence', item['confidence']), **evidence}

    return {**item, 'verdict': 'cannot-refute'}


def resolve_verdicts(findings: list[dict], verdicts: list[dict]) -> list[dict]:
    by_id = {v.get('id'): v for v in verdicts if isinstance(v, dict)}
    resolved = []

    for item in findings:
        verdict = by_id.get(item['id'])
        duplicate = (verdict or {}).get('duplicateOf')
        resolved.append({**verdict_of(item, verdict), 'lines': [item['line']], **({'duplicateOf': duplicate} if duplicate else {})})

    return resolved


def strength(item: dict, bucket: int) -> tuple[int, int, int]:
    return bucket, SEVERITY_RANK[item['severity']], item['confidence']


def without_duplicate(item: dict) -> dict:
    return {key: value for key, value in item.items() if key != 'duplicateOf'}


def fold_duplicates(kept: list[dict], below: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    survivors = {item['id']: (item, 1) for item in kept} | {item['id']: (item, 0) for item in below}
    merged, dropped = dict(survivors), []

    for item_id in survivors:
        if item_id not in merged:
            continue
        item, bucket = merged[item_id]
        target_id = item.get('duplicateOf')
        if target_id not in merged or target_id == item_id or merged[target_id][0]['file'] != item['file']:
            continue
        target, target_bucket = merged[target_id]
        keep, keep_bucket, lose = (item, bucket, target) if strength(item, bucket) > strength(target, target_bucket) else (target, target_bucket, item)
        lines = sorted({*keep['lines'], *lose['lines']})
        merged[keep['id']] = ({**keep, 'lines': lines, 'line': lines[0]}, keep_bucket)
        del merged[lose['id']]
        dropped.append({'id': lose['id'], 'reason': f"duplicate-of:{keep['id']}"})

    return [without_duplicate(i) for i, b in merged.values() if b == 1], [without_duplicate(i) for i, b in merged.values() if b == 0], dropped


def with_mark(item: dict, row: dict) -> dict:
    return {**item, **({'mark': row['mark']} if 'mark' in row else {})}


def apply_threshold(items: list[dict], table: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    kept, below, dropped = [], [], []

    for item in items:
        row = next((r for r in table if r['verdict'] == item['verdict'] and item['severity'] in r['severity'] and item['confidence'] >= r['min']), None)
        if row is None:
            reason = f"refuted:{item['evidence']}" if item['verdict'] == 'refuted' else f"below-threshold:{item['verdict']}:{item['severity']}:{item['confidence']}"
            dropped.append({'id': item['id'], 'reason': reason})
        elif row['result'] == 'in':
            kept.append(with_mark(item, row))
        else:
            below.append(with_mark(item, row))

    return kept, below, dropped


def gate_notes(directory: str) -> list[str]:
    paths = sorted(glob.glob(os.path.join(directory, 'gate-*.jsonl')))
    if not paths:
        return ['гейт чтения: записей нет — чтение агентов не подтверждено']

    rows = [json.loads(line) for path in paths for line in open(path, encoding='utf-8') if line.strip()]
    return [
        f"агент {row['role']}: гейт чтения — {row['event']}" + (f": не прочитаны {', '.join(row['unread'])}" if row.get('unread') else '') + (f" ({row['error']})" if row.get('error') else '')
        for row in rows if row.get('event') in GATE_FAILURES
    ]


def manifest_notes(directory: str) -> list[str]:
    lines = [line.strip() for path in sorted(glob.glob(os.path.join(directory, 'manifest-*.txt'))) for line in open(path, encoding='utf-8')]
    return list(dict.fromkeys(line[2:] for line in lines if line.startswith('# ')))


def cited_rules(repo: str, items: list[dict]) -> dict[str, str]:
    paths = {item['rule']['file'].removeprefix('./') for item in items if isinstance(item.get('rule'), dict)}
    allowed = [p for p in paths if p.startswith(RULE_PREFIXES) and os.path.isfile(os.path.join(repo, p))]
    return {p: open(os.path.join(repo, p), encoding='utf-8').read() for p in allowed}


def checked(items: list[dict], repo: str, base: str, head: str) -> tuple[list[dict], list[dict], list[str]]:
    changed = changed_files(repo, base, head)
    states = file_states(repo, base, head)
    line_counts = {path: len(text.splitlines()) for path, (text, _) in states.items() if text is not None}
    rules = cited_rules(repo, items)
    kept, dropped = [], []

    for item in items:
        result, reason = checked_item(with_evidence_line(item, line_counts), rules, changed, line_counts)
        if result is None:
            dropped.append({'id': item['id'], 'reason': reason})
        else:
            kept.append(result)

    skipped = [f'{path} — не приложен: {why}' for path, why in not_attached(states, MAX_FILE_CHARS).items()]
    return kept, dropped, skipped


def read_raw(path: str) -> dict:
    raw = json.load(open(path, encoding='utf-8'))
    result = raw.get('result') if 'workflowProgress' in raw else raw
    if not isinstance(result, dict) or not isinstance(result.get('findings'), list):
        sys.stderr.write('funnel_finish: Workflow не вернул результат — ревью агентами не состоялось\n')
        sys.exit(INCOMPLETE)
    if result.get('roles') and set(result['roles']) <= set(result.get('failed', [])):
        sys.stderr.write(f"funnel_finish: ни один агент-искатель не ответил ({', '.join(result['roles'])}) — ревью агентами не состоялось\n")
        sys.exit(INCOMPLETE)

    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    for name in ('--raw', '--base', '--head', '--out'):
        parser.add_argument(name, required=True)
    parser.add_argument('--repo', default='.')
    args = parser.parse_args()

    raw = read_raw(args.raw)
    config = json.load(open(os.path.join(os.path.dirname(__file__), '..', 'config', 'funnel.json'), encoding='utf-8'))

    resolved = resolve_verdicts(raw['findings'], raw['verdicts'])
    valid, invalid, skipped = checked(resolved, args.repo, args.base, args.head)
    passed, passed_below, below_bar_dropped = apply_threshold(valid, config['threshold'])
    kept, below, folded = fold_duplicates(passed, passed_below)
    funnel = os.path.dirname(os.path.abspath(args.raw))
    notes = [*raw['notChecked'], *skipped, *manifest_notes(funnel), *gate_notes(funnel)]
    notes += [f'агент {role} не ответил — угол {role} не проверен' for role in raw['failed']]
    notes += ['агент C не ответил — вердиктов нет'] if raw['refuter'] == 'failed' else []

    result = {'findings': kept, 'belowBar': below, 'dropped': [*invalid, *below_bar_dropped, *folded], 'notChecked': list(dict.fromkeys(notes))}
    os.makedirs(args.out, exist_ok=True)
    json.dump(result, open(os.path.join(args.out, 'findings.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
