import argparse, json, os, subprocess, sys

from forgejo import request

LINE_WINDOW = 5
def ensure_commit(number: int, sha: str) -> None:
    has = lambda: subprocess.run(['git', 'cat-file', '-e', f'{sha}^{{commit}}'], capture_output=True).returncode == 0
    if has():
        return

    subprocess.run(['git', 'fetch', '-q', 'origin', f'+refs/pull/{number}/head:refs/remotes/origin/pr/{number}'], capture_output=True)
    if not has():
        subprocess.run(['git', 'fetch', '-q', 'origin', sha], capture_output=True)
    if not has():
        raise ValueError(f'коммит {sha} PR {number} недоступен локально и не скачивается')


def pr_base(commits: list[dict]) -> str:
    own = {c['sha'] for c in commits}
    outside = sorted({p['sha'] for c in commits for p in c.get('parents', []) if p['sha'] not in own})
    if len(outside) != 1:
        raise ValueError(f'у коммитов PR не один внешний родитель: {", ".join(outside) or "нет коммитов"}')

    return outside[0]


def choose_base(commits: list[dict], head_first_parent: str) -> tuple[str, str]:
    try:
        return pr_base(commits), 'pr-commits'
    except ValueError:
        return head_first_parent, 'head-first-parent'


def first_round(pr: dict, reviews: list[dict], comments_by_review: dict[int, list[dict]]) -> dict:
    author = pr['user']['login']
    foreign = sorted((r for r in reviews if r['user']['login'] != author and r.get('comments_count')), key=lambda r: r['submitted_at'])
    if not foreign:
        raise ValueError('в PR нет инлайн-замечаний людей')

    head = foreign[0]['commit_id']
    comments = [
        {
            'path': c['path'],
            'line': c['position'] or c['original_position'],
            'side': 'new' if c['position'] else 'old',
            'body': c['body'],
            'author': r['user']['login'],
        }
        for r in foreign if r['commit_id'] == head
        for c in comments_by_review.get(r['id'], [])
    ]

    return {'base': pr['merge_base'], 'head': head, 'comments': comments}


def match(findings: list[dict], human: list[dict], window: int = LINE_WINDOW) -> dict:
    new_side = [h for h in human if h['side'] == 'new']
    near = lambda f, h: f['file'] == h['path'] and abs(f['line'] - h['line']) <= window
    pairs = [(f['id'], i) for i, h in enumerate(new_side) for f in findings if near(f, h)]
    covered = {i for _, i in pairs}
    used = {fid for fid, _ in pairs}

    return {
        'matched': [{'finding': fid, 'path': new_side[i]['path'], 'line': new_side[i]['line']} for fid, i in dict.fromkeys(pairs)],
        'recall': len(covered) / len(new_side) if new_side else None,
        'unmatched_findings': [f for f in findings if f['id'] not in used],
        'missed': [h for i, h in enumerate(new_side) if i not in covered],
        'old_side': len(human) - len(new_side),
    }


def fetch(number: int) -> None:
    pr = request('GET', f'/pulls/{number}')
    reviews = request('GET', f'/pulls/{number}/reviews')
    comments = {r['id']: request('GET', f'/pulls/{number}/reviews/{r["id"]}/comments') for r in reviews if r.get('comments_count')}
    round_ = first_round(pr, reviews, comments)
    ensure_commit(number, round_['head'])
    head_parent = subprocess.run(['git', 'rev-parse', f'{round_["head"]}^1'], check=True, capture_output=True, text=True).stdout.strip()
    base, rule = choose_base(request('GET', f'/pulls/{number}/commits?limit=100'), head_parent)
    round_ = {**round_, 'base': base, 'baseRule': rule}
    ensure_commit(number, round_['base'])

    directory = f'.review-kit/eval/pr-{number}'
    os.makedirs(directory, exist_ok=True)
    json.dump(round_, open(f'{directory}/human.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print(f'{directory}/human.json: base {round_["base"]}, head {round_["head"]}, замечаний {len(round_["comments"])}')


def score(findings_path: str, human_path: str) -> None:
    findings = json.load(open(findings_path, encoding='utf-8'))['findings']
    human = json.load(open(human_path, encoding='utf-8'))['comments']
    result = match(findings, human)
    print(f'находок {len(findings)}, замечаний людей {len(human)} (на удалённых строках {result["old_side"]}), полнота {result["recall"]}')
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd', required=True)
    sub.add_parser('fetch').add_argument('number', type=int)
    scoring = sub.add_parser('score')
    scoring.add_argument('findings')
    scoring.add_argument('human')
    args = parser.parse_args()
    fetch(args.number) if args.cmd == 'fetch' else score(args.findings, args.human)
