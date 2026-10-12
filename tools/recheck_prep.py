import argparse, json, os, subprocess, sys

from forgejo import ForgejoError, parse_time, read_login
from pr_context import fetch, is_me

FULL_NOTE = 'после rebase/force-push моего ревью нет в истории — проверено всё от базы PR'


def run_git(repo: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(['git', '-C', repo, *args], capture_output=True, text=True)


def choose_base(repo: str, last_commit: str, head: str, base_rev: str) -> dict:
    if run_git(repo, 'merge-base', '--is-ancestor', last_commit, head).returncode == 0:
        return {'base': last_commit, 'mode': 'delta'}

    merge_base = run_git(repo, 'merge-base', base_rev, head)
    if merge_base.returncode != 0:
        merge_base = run_git(repo, 'merge-base', 'origin/main', head)
    return {'base': merge_base.stdout.strip(), 'mode': 'full', 'note': FULL_NOTE}


def prior_comments(reviews: list[dict], review_comments: list[dict], login: str) -> tuple[dict, list[dict]]:
    mine = [r for r in reviews if is_me(r['user'], login) and r['state'] != 'PENDING']
    last = max(mine, key=lambda r: parse_time(r['submitted_at']))
    prior = [
        {'id': f"{last['id']}/{c['id']}", 'reviewId': last['id'], 'path': c['path'], 'line': c['position'], 'author': login, 'body': c['body'], 'quote': c['body']}
        for c in review_comments if c['pull_request_review_id'] == last['id'] and is_me(c['user'], login)
    ]
    if (last.get('body') or '').strip():
        prior.append({'id': f"review/{last['id']}", 'reviewId': last['id'], 'path': None, 'line': None, 'author': login, 'body': last['body'], 'quote': last['body']})
    return last, prior


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('number', type=int)
    for name in ('--head', '--base-ref', '--out'):
        parser.add_argument(name, required=True)
    parser.add_argument('--repo', default='.')
    args = parser.parse_args()

    try:
        pr, reviews, comments, _ = fetch(args.number)
        last, prior = prior_comments(reviews, comments, read_login(args.repo))
    except (ForgejoError, KeyError, TypeError, ValueError) as error:
        sys.stderr.write(f'recheck_prep: {error}\n')
        sys.exit(5)

    result = {**choose_base(args.repo, last['commit_id'], args.head, f'origin/{args.base_ref}'), 'reviewId': last['id'], 'prior': prior}
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, 'recheck.json'), 'w', encoding='utf-8') as out:
        json.dump(result, out, ensure_ascii=False, indent=2)
    json.dump({key: result[key] for key in ('base', 'mode')} | {'prior': len(prior)}, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
