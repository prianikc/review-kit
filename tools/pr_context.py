import json, sys

from forgejo import ForgejoError, parse_time, read_login, request

ACTIONABLE = ('feedback', 'review', 'recheck')
REMARK_STATES = ('REQUEST_CHANGES', 'COMMENT')
PAGE = 50


def is_me(user: dict | None, login: str) -> bool:
    return bool(user) and user['login'].lower() == login.lower()


def threads(review_comments: list[dict]) -> list[list[dict]]:
    groups: dict[tuple, list[dict]] = {}
    for item in review_comments:
        groups.setdefault((item['pull_request_review_id'], item['path'], item['position']), []).append(item)
    return [sorted(group, key=lambda c: parse_time(c['created_at'])) for group in groups.values()]


def has_feedback(reviews: list[dict], review_comments: list[dict], issue_comments: list[dict], login: str) -> bool:
    drafts = {r['id'] for r in reviews if r['state'] == 'PENDING'}
    reviews = [r for r in reviews if r['id'] not in drafts]
    review_comments = [c for c in review_comments if c['pull_request_review_id'] not in drafts]
    open_threads = [t for t in threads(review_comments) if all(c.get('resolver') is None for c in t)]
    if any(not is_me(t[-1]['user'], login) for t in open_threads):
        return True

    general = sorted(issue_comments, key=lambda c: parse_time(c['created_at']))
    if general and not is_me(general[-1]['user'], login):
        return True

    mine = [parse_time(c['created_at']) for c in [*review_comments, *issue_comments] if is_me(c['user'], login)]
    mine += [parse_time(r['submitted_at']) for r in reviews if is_me(r['user'], login)]
    my_last = max(mine, default=None)
    return any(
        r['state'] in REMARK_STATES and (r.get('body') or '').strip() and not is_me(r['user'], login)
        and (my_last is None or parse_time(r['submitted_at']) > my_last)
        for r in reviews
    )


def needs_recheck(pr: dict, mine: list[dict], review_comments: list[dict], login: str) -> bool:
    last = max(mine, key=lambda r: parse_time(r['submitted_at']))
    if last['commit_id'] != pr['head']['sha']:
        return True

    author = pr['user']
    return any(any(is_me(c['user'], login) for c in t) and is_me(t[-1]['user'], author['login']) for t in threads(review_comments))


def scenario(pr: dict, reviews: list[dict], review_comments: list[dict], issue_comments: list[dict], login: str) -> str:
    if pr['state'] == 'closed':
        return 'closed'
    if is_me(pr['user'], login):
        return 'feedback' if has_feedback(reviews, review_comments, issue_comments, login) else 'none-own'

    mine = [r for r in reviews if is_me(r['user'], login) and r['state'] != 'PENDING']
    if not mine:
        return 'review'
    return 'recheck' if needs_recheck(pr, mine, review_comments, login) else 'wait-author'


def fetch(number: int, pr: dict | None = None) -> tuple[dict, list[dict], list[dict], list[dict]]:
    pr = pr or request('GET', f'/pulls/{number}')
    reviews = request('GET', f'/pulls/{number}/reviews?limit={PAGE}')
    comments = [c for r in reviews for c in request('GET', f"/pulls/{number}/reviews/{r['id']}/comments")]
    return pr, reviews, comments, request('GET', f'/issues/{number}/comments?limit={PAGE}')


def context(pr: dict, login: str, routed: str) -> dict:
    author = pr['user']['login']
    return {
        'number': pr['number'], 'title': pr['title'], 'author': author, 'isOwn': author.lower() == login.lower(),
        'headRef': pr['head']['ref'], 'headSha': pr['head']['sha'], 'baseRef': pr['base']['ref'], 'state': pr['state'],
        'merged': bool(pr.get('merged')), 'url': pr['html_url'], 'scenario': routed,
    }


def actionable(login: str) -> list[dict]:
    rows = []
    for pr in request('GET', f'/pulls?state=open&limit={PAGE}'):
        routed = scenario(*fetch(pr['number'], pr), login)
        if routed in ACTIONABLE:
            rows.append({'number': pr['number'], 'title': pr['title'], 'author': pr['user']['login'], 'isOwn': is_me(pr['user'], login), 'scenario': routed})
    return sorted(rows, key=lambda row: (not row['isOwn'], row['number']))


def main() -> None:
    try:
        login = read_login('.')
        if sys.argv[1:] == ['--list']:
            result = actionable(login)
        else:
            pr, reviews, comments, issues = fetch(int(sys.argv[1]))
            result = context(pr, login, scenario(pr, reviews, comments, issues, login))
    except (ForgejoError, IndexError, ValueError, KeyError, TypeError) as error:
        sys.stderr.write(f'pr_context: {error}\n')
        sys.exit(5)

    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
