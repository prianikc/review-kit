import json, os, re, subprocess, sys
from pathlib import Path

from forgejo import ForgejoError, read_login, request

STASH_PREFIX = 'review-kit:'
DETACHED = '(no branch)'
BASE_BRANCH = 'main'
PAGE = 50
STASH_COMMANDS = {'apply': 'pop', 'drop': 'drop'}
REVIEW_WORKTREE = re.compile(r'^pr-(\d+)-')
SESSION = '.review-kit/run/{pr}/session.json'


def git(repo: str, *args: str) -> str:
    return subprocess.run(['git', '-C', repo, *args], check=True, capture_output=True, text=True).stdout


def refresh(repo: str) -> None:
    git(repo, 'fetch', '-q', 'origin', '--prune')


def all_on_origin(repo: str, ref: str) -> bool:
    return git(repo, 'rev-list', ref, '--not', '--remotes=origin').strip() == ''


def busy_branches(repo: str) -> set[str]:
    lines = git(repo, 'worktree', 'list', '--porcelain').splitlines()
    return {line.removeprefix('branch refs/heads/') for line in lines if line.startswith('branch refs/heads/')}


def branch_candidates(repo: str, open_prs: list[dict], closed_prs: list[dict], login: str) -> list[dict]:
    open_by_ref = {pr['head']['ref']: pr for pr in open_prs}
    closed_by_ref = {pr['head']['ref']: pr for pr in closed_prs}
    busy = busy_branches(repo)
    names = git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split()
    rows = []

    for name in names:
        opened, closed = open_by_ref.get(name), closed_by_ref.get(name)
        if name == BASE_BRANCH or name in busy or not all_on_origin(repo, name):
            continue
        if opened and opened['user']['login'].lower() == login.lower():
            continue
        if opened:
            rows.append({'name': name, 'kind': 'pr', 'reason': f"чужой открытый PR #{opened['number']} — коммиты на origin"})
        elif closed:
            rows.append({'name': name, 'kind': 'pr', 'reason': f"PR #{closed['number']} {'влит' if closed.get('merged') else 'закрыт'} — коммиты на origin"})
        else:
            rows.append({'name': name, 'kind': 'no-pr', 'reason': 'PR нет среди последних — коммиты на origin'})

    return rows


def review_stashes(repo: str) -> list[dict]:
    rows = []

    for line in git(repo, 'stash', 'list', '--format=%H\t%gs').splitlines():
        sha, _, subject = line.partition('\t')
        head, _, message = subject.partition(': ')
        if not message.startswith(STASH_PREFIX):
            continue
        branch = head.removeprefix('WIP on ').removeprefix('On ').strip()
        rows.append({'sha': sha, 'message': message, 'branch': '' if branch == DETACHED else branch})

    return rows


def stash_ref(repo: str, sha: str) -> str | None:
    for index, line in enumerate(git(repo, 'stash', 'list', '--format=%H').splitlines()):
        if line == sha:
            return f'stash@{{{index}}}'
    return None


def stash_action(repo: str, sha: str, action: str) -> dict:
    if action == 'keep':
        return {'sha': sha, 'action': action, 'ok': True}

    ref = stash_ref(repo, sha)
    if ref is None:
        return {'sha': sha, 'action': action, 'ok': False, 'error': 'stash уже не найден'}
    run = subprocess.run(['git', '-C', repo, 'stash', STASH_COMMANDS[action], ref], capture_output=True, text=True)
    if run.returncode != 0:
        unmerged = git(repo, 'diff', '--name-only', '--diff-filter=U').split()
        if unmerged:
            return {'sha': sha, 'action': action, 'ok': False, 'conflict': True, 'error': f'применён с конфликтом в: {", ".join(unmerged)}; stash сохранён'}
        return {'sha': sha, 'action': action, 'ok': False, 'error': (run.stderr or run.stdout).strip()}

    return {'sha': sha, 'action': action, 'ok': True}


def delete_branches(repo: str, names: list[str]) -> dict:
    busy = busy_branches(repo)
    deleted, skipped = [], []

    for name in names:
        if name == BASE_BRANCH or name in busy:
            skipped.append({'name': name, 'reason': 'ветка занята или базовая'})
        elif not all_on_origin(repo, name):
            skipped.append({'name': name, 'reason': 'есть коммиты, которых нет на origin'})
        else:
            try:
                git(repo, 'branch', '-D', name)
                deleted.append(name)
            except subprocess.CalledProcessError as error:
                skipped.append({'name': name, 'reason': (error.stderr or str(error)).strip()})

    return {'deleted': deleted, 'skipped': skipped}


def worktrees(repo: str) -> list[tuple[str, str]]:
    rows: list[tuple[str, str]] = []
    for line in git(repo, 'worktree', 'list', '--porcelain').splitlines():
        if line.startswith('worktree '):
            rows.append((line.removeprefix('worktree '), ''))
        elif line.startswith('branch refs/heads/'):
            rows[-1] = (rows[-1][0], line.removeprefix('branch refs/heads/'))
    return rows


def in_main_tree(repo: str) -> bool:
    return os.path.realpath(git(repo, 'rev-parse', '--show-toplevel').strip()) == os.path.realpath(worktrees(repo)[0][0])


def run_active(path: str, pr: int) -> bool:
    session = os.path.join(path, SESSION.format(pr=pr))
    if not os.path.isfile(session):
        return False
    try:
        with open(session) as f:
            return json.load(f).get('status') == 'active'
    except (OSError, ValueError, AttributeError):
        return True


def review_worktrees(repo: str) -> list[dict]:
    rows = worktrees(repo)
    home = os.path.join(rows[0][0], '.claude', 'worktrees')
    found = []

    for path, branch in rows[1:]:
        match = REVIEW_WORKTREE.match(os.path.basename(path))
        if os.path.dirname(path) != home or not match:
            continue
        pr = int(match.group(1))
        dirty = git(path, 'status', '--porcelain', '--ignore-submodules=all').strip() != ''
        found.append({'path': path, 'pr': pr, 'branch': branch, 'active': run_active(path, pr), 'dirty': dirty})

    return found


def branch_unneeded(repo: str, name: str, open_by_ref: dict, login: str) -> bool:
    opened = open_by_ref.get(name)
    if not name or name == BASE_BRANCH or not all_on_origin(repo, name):
        return False
    return not (opened and opened['user']['login'].lower() == login.lower())


def worktree_candidates(repo: str, open_prs: list[dict], closed_prs: list[dict], login: str) -> list[dict]:
    open_by_ref = {pr['head']['ref']: pr for pr in open_prs}
    return [
        {'path': wt['path'], 'pr': wt['pr'], 'branch': wt['branch'], 'deleteBranch': branch_unneeded(repo, wt['branch'], open_by_ref, login)}
        for wt in review_worktrees(repo)
        if not wt['active'] and not wt['dirty']
    ]


def holder(repo: str, branch: str) -> dict:
    here = os.path.realpath(git(repo, 'rev-parse', '--show-toplevel').strip())
    return next((wt for wt in review_worktrees(repo) if wt['branch'] == branch and os.path.realpath(wt['path']) != here), {})


def unlink_memory(path: str) -> None:
    home = Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home() / '.claude')
    link = home / 'projects' / re.sub(r'[^A-Za-z0-9]', '-', path) / 'memory'
    if link.is_symlink():
        link.unlink()


def remove_worktrees(repo: str, paths: list[str], confirmed: bool) -> dict:
    known = {wt['path']: wt for wt in review_worktrees(repo)}
    removed, skipped = [], []

    for path in paths:
        wt = known.get(path)
        if wt is None:
            skipped.append({'path': path, 'reason': 'не worktree ревью'})
        elif not confirmed and (wt['active'] or wt['dirty']):
            skipped.append({'path': path, 'reason': 'ревью идёт или есть изменения'})
        else:
            git(repo, 'worktree', 'remove', '--force', path)
            unlink_memory(path)
            removed.append(path)

    return {'removed': removed, 'skipped': skipped}


def main() -> None:
    args = sys.argv[1:]
    if args[:1] in (['list'], ['delete-branches']):
        try:
            refresh('.')
        except subprocess.CalledProcessError as error:
            sys.stderr.write(f'cleanup: git fetch не удался — уборка пропущена: {(error.stderr or "").strip()}\n')
            sys.exit(5)
    try:
        if args[:1] == ['list']:
            open_prs = request('GET', f'/pulls?state=open&limit={PAGE}')
            closed_prs = request('GET', f'/pulls?state=closed&limit={PAGE}')
            login = read_login('.')
            result = {
                'branches': branch_candidates('.', open_prs, closed_prs, login),
                'stashes': review_stashes('.'),
                'worktrees': worktree_candidates('.', open_prs, closed_prs, login) if in_main_tree('.') else [],
            }
        elif args[:1] == ['delete-branches'] and len(args) > 1:
            result = delete_branches('.', args[1:])
        elif args[:1] == ['stash'] and len(args) == 3 and args[2] in ('keep', 'apply', 'drop'):
            result = stash_action('.', args[1], args[2])
        elif args[:1] == ['holder'] and len(args) == 2:
            result = holder('.', args[1])
        elif args[:1] == ['remove-worktrees'] and [a for a in args[1:] if a != '--confirmed']:
            result = remove_worktrees('.', [a for a in args[1:] if a != '--confirmed'], confirmed='--confirmed' in args)
        else:
            sys.stderr.write('cleanup: list | delete-branches <ветка>... | stash <sha> keep|apply|drop | holder <ветка> | remove-worktrees [--confirmed] <путь>...\n')
            sys.exit(64)
    except (ForgejoError, KeyError, TypeError) as error:
        sys.stderr.write(f'cleanup: {error}\n')
        sys.exit(5)
    except subprocess.CalledProcessError as error:
        sys.stderr.write(f'cleanup: git: {(error.stderr or "").strip()}\n')
        sys.exit(2)

    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
