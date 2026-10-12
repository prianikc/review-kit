import argparse, json, os, sys

from forgejo import ForgejoError, parse_time, read_login
from pr_context import fetch, is_me, threads

MARKER = '<!-- review-kit -->'
REMARK_STATES = ('REQUEST_CHANGES', 'COMMENT')


def mine(comment: dict, login: str) -> bool:
    return is_me(comment.get('user'), login) or MARKER in (comment.get('body') or '')


def thread_items(review_comments: list[dict], login: str, head: str) -> list[dict]:
    items = []
    for thread in threads(review_comments):
        if any(c.get('resolver') is not None for c in thread) or mine(thread[-1], login):
            continue
        first = thread[0]
        commit = first.get('commit_id') or ''
        items.append({
            'id': f"{first['pull_request_review_id']}/{first['id']}", 'kind': 'thread', 'reviewId': first['pull_request_review_id'],
            'path': first['path'], 'position': first['position'], 'commitId': commit, 'author': thread[-1]['user']['login'],
            'quote': '\n'.join(f"{c['user']['login']}: {c['body']}" for c in thread), 'stale': commit != head,
            'disagree': any(mine(c, login) for c in thread[:-1]),
        })
    return items


def general_items(issue_comments: list[dict], reviews: list[dict], review_comments: list[dict], login: str) -> list[dict]:
    my_times = [parse_time(c['created_at']) for c in [*issue_comments, *review_comments] if mine(c, login)]
    my_times += [parse_time(r['submitted_at']) for r in reviews if is_me(r['user'], login)]
    my_last = max(my_times, default=None)

    def later(moment) -> bool:
        return my_last is None or moment > my_last

    items = [
        {'id': f"issue/{c['id']}", 'kind': 'issue', 'reviewId': None, 'path': None, 'position': None, 'commitId': '',
         'author': c['user']['login'], 'quote': c.get('body') or '', 'stale': False, 'disagree': False}
        for c in issue_comments if not mine(c, login) and later(parse_time(c['created_at']))
    ]
    items += [
        {'id': f"review/{r['id']}", 'kind': 'review', 'reviewId': r['id'], 'path': None, 'position': None, 'commitId': r.get('commit_id') or '',
         'author': r['user']['login'], 'quote': r['body'], 'stale': False, 'disagree': False}
        for r in reviews
        if r['state'] in REMARK_STATES and (r.get('body') or '').strip() and not is_me(r['user'], login) and later(parse_time(r['submitted_at']))
    ]
    return items


def intake(pr: dict, reviews: list[dict], review_comments: list[dict], issue_comments: list[dict], login: str) -> dict:
    drafts = {r['id'] for r in reviews if r['state'] == 'PENDING'}
    reviews = [r for r in reviews if r['id'] not in drafts]
    review_comments = [c for c in review_comments if c['pull_request_review_id'] not in drafts]
    head = pr['head']['sha']

    return {'head': head, 'items': thread_items(review_comments, login, head) + general_items(issue_comments, reviews, review_comments, login)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('number', type=int)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    try:
        result = intake(*fetch(args.number), read_login('.'))
    except (ForgejoError, KeyError, TypeError, ValueError) as error:
        sys.stderr.write(f'intake: {error}\n')
        sys.exit(5)

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, 'intake.json'), 'w', encoding='utf-8') as out:
        json.dump(result, out, ensure_ascii=False, indent=2)
    json.dump({'items': len(result['items'])}, sys.stdout)


if __name__ == '__main__':
    main()
