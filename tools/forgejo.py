import argparse, http.client, json, os, sys, time, urllib.error, urllib.request
from datetime import datetime
from typing import Callable

CONFIG_PATHS = ('.claude/review-kit.local.json', '.claude/review-skills.local.json')
POST_OK_SENTINEL = 'review-kit:post-review:ok'
POST_REPLIES_OK_SENTINEL = 'review-kit:post-replies:ok'
REQUEST_TIMEOUT_SECONDS = 30
RECONCILE_ATTEMPTS = 3
RECONCILE_PAUSE_SECONDS = 5
UNKNOWN_STATUS = 'статус публикации неизвестен'


class ForgejoError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def kit_config(repo: str) -> dict:
    for name in CONFIG_PATHS:
        path = os.path.join(repo, name)
        if os.path.isfile(path):
            with open(path, encoding='utf-8') as config:
                return json.load(config)
    raise ForgejoError(f'нет {CONFIG_PATHS[0]} (и прежнего {CONFIG_PATHS[1]}) в {repo}: настройки взять неоткуда')


def forgejo_settings(repo: str) -> tuple[str, str, str, str]:
    forgejo = kit_config(repo)['forgejo']
    host, owner, name = forgejo['host'], forgejo['owner'], forgejo['repo']
    token = os.path.expanduser(forgejo.get('tokenFile') or f'~/.config/forgejo/{host}/{owner}/{name}/token')

    return host, owner, name, token


def login_path(token_path: str) -> str:
    return os.path.join(os.path.dirname(token_path), 'login')


def read_login(repo: str) -> str:
    path = login_path(forgejo_settings(repo)[3])
    if not os.path.isfile(path):
        raise ForgejoError(f'нет файла login рядом с токеном ({path}): запишите туда свой логин Forgejo')

    return open(path, encoding='utf-8').read().strip()


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def request(method: str, path: str, body: dict | None = None, repo: str = '.') -> object:
    host, owner, name, token_path = forgejo_settings(repo)
    token = open(token_path, encoding='utf-8').read().strip()
    data = json.dumps(body).encode('utf-8') if body is not None else None
    headers = {'Authorization': f'token {token}', 'Content-Type': 'application/json'}
    req = urllib.request.Request(f'https://{host}/api/v1/repos/{owner}/{name}{path}', data=data, headers=headers, method=method)

    try:
        raw = urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS).read()
    except urllib.error.HTTPError as error:
        raise ForgejoError(f'{method} {path}: HTTP {error.code} {error.read().decode("utf-8", "replace")[:500]}', error.code) from error
    except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError) as error:
        raise ForgejoError(f'{method} {path}: сеть: {error}') from error

    return json.loads(raw) if raw else None


def review_ids(number: int) -> set[int]:
    return {review['id'] for review in request('GET', f'/pulls/{number}/reviews?limit=50')}


def post_review(number: int, payload: dict, before: set[int], sleep: Callable[[float], None] = time.sleep) -> dict:
    try:
        return request('POST', f'/pulls/{number}/reviews', payload)
    except ForgejoError as error:
        if error.status is not None:
            raise

        login = read_login('.')
        for attempt in range(RECONCILE_ATTEMPTS):
            if attempt:
                sleep(RECONCILE_PAUSE_SECONDS)
            try:
                reviews = request('GET', f'/pulls/{number}/reviews?limit=50')
            except ForgejoError:
                continue
            found = [r for r in reviews if r['id'] not in before and r['user']['login'].lower() == login.lower() and r.get('body') == payload.get('body')]
            if found:
                return found[-1]

        raise ForgejoError(f'{error}; {UNKNOWN_STATUS} — проверьте PR {number} перед повтором') from error


def post_replies(number: int, payload: list[dict]) -> list[str]:
    sent: list[str] = []
    for reply in payload:
        try:
            if reply['kind'] == 'thread':
                request('POST', f"/pulls/{number}/reviews/{reply['reviewId']}/comments", {'path': reply['path'], 'new_position': reply['position'], 'body': reply['body']})
            else:
                request('POST', f'/issues/{number}/comments', {'body': f"> {reply['quote']}\n\n{reply['body']}"})
        except ForgejoError as error:
            raise ForgejoError(f'{error}; уже отправлены: {", ".join(sent) or "—"}', error.status) from error
        sent.append(reply['id'])
    return sent


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd', required=True)
    sub.add_parser('get').add_argument('path')
    post = sub.add_parser('post-review')
    post.add_argument('number', type=int)
    post.add_argument('--payload', required=True)
    replies = sub.add_parser('post-replies')
    replies.add_argument('number', type=int)
    replies.add_argument('--payload', required=True)
    args = parser.parse_args()

    try:
        if args.cmd == 'get':
            json.dump(request('GET', args.path), sys.stdout, ensure_ascii=False, indent=2)
            return
        payload = json.load(open(args.payload, encoding='utf-8'))
        if args.cmd == 'post-replies':
            sent = post_replies(args.number, payload)
            print(POST_REPLIES_OK_SENTINEL)
            print(f'отправлено: {len(sent)}')
            return
        review = post_review(args.number, payload, review_ids(args.number))
    except ForgejoError as error:
        sys.stderr.write(f'forgejo: {error}\n')
        sys.exit(5)

    print(POST_OK_SENTINEL)
    print(review.get('html_url', '') if isinstance(review, dict) else '')


if __name__ == '__main__':
    main()
