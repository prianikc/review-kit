import json, sys

TOKENS = ('input', 'output', 'cacheRead', 'cacheCreation')
DEFAULT_PATH = '.review-kit/usage.jsonl'


def summarize(rows: list[dict]) -> list[dict]:
    groups: dict[tuple, dict] = {}

    for row in rows:
        group = groups.setdefault((row['session'], row['pr']), {'session': row['session'], 'pr': row['pr'], 'stepsMain': 0, 'stepsAgents': 0, **{key: 0 for key in TOKENS}})
        group['stepsAgents' if row.get('agentId') else 'stepsMain'] += 1
        for key in TOKENS:
            group[key] += row.get(key) or 0

    return list(groups.values())


def read_rows(path: str) -> list[dict]:
    rows = []
    for line in open(path, encoding='utf-8'):
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and 'session' in row and 'pr' in row:
            rows.append(row)
    return rows


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PATH
    json.dump(summarize(read_rows(path)), sys.stdout, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
