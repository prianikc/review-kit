import argparse, json, os, re, subprocess, sys

from forgejo import ForgejoError, kit_config

CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'config', 'checks.json')
ANSI = re.compile(r'\x1b\[[0-9;]*m')
NX_PREFIX = re.compile(r'^[\w@./-]+:[\w-]+\s+')
TSC = re.compile(r'^(?P<file>[^\s(]+)\(\d+,\d+\): error (?P<rule>TS\d+): (?P<message>.+)$')
ESLINT_FILE = re.compile(r'^(/\S+|[\w./@-]+\.\w+)$')
ESLINT_ROW = re.compile(r'^\s+\d+:\d+\s+error\s+(?P<message>.+?)\s{2,}(?P<rule>[\w/@-]+)$')


def clean(line: str) -> str:
    return NX_PREFIX.sub('', ANSI.sub('', line))


def parse(output: str) -> set[tuple]:
    errors, file = set(), None
    for raw in output.splitlines():
        line = clean(raw)
        tsc = TSC.match(line.strip())
        row = ESLINT_ROW.match(line)
        if tsc:
            errors.add((tsc['file'], tsc['rule'], tsc['message'].strip()))
        elif ESLINT_FILE.match(line.strip()) and not line.startswith(' '):
            file = line.strip()
        elif file and row:
            errors.add((file, row['rule'], row['message'].strip()))
    return errors


def compare(baseline: set[tuple], current: set[tuple]) -> dict:
    return {'new': sorted([list(e) for e in current - baseline]), 'old': len(current & baseline)}


def run_checks(config: dict) -> set[tuple]:
    errors = set()
    for command in config['commands']:
        done = subprocess.run(command, capture_output=True, text=True, timeout=config.get('timeoutSec', 900))
        errors |= parse(f'{done.stdout}\n{done.stderr}')
    return errors


def checks_config(path: str | None) -> dict:
    if path:
        return json.load(open(path, encoding='utf-8'))
    try:
        checks = kit_config('.').get('checks')
    except (ForgejoError, ValueError):
        checks = None
    return checks or json.load(open(CONFIG, encoding='utf-8'))


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd', required=True)
    sub.add_parser('snapshot').add_argument('--out', required=True)
    sub.add_parser('compare').add_argument('--baseline', required=True)
    parser.add_argument('--config')
    args = parser.parse_args()

    try:
        current = run_checks(checks_config(args.config))
        if args.cmd == 'snapshot':
            with open(args.out, 'w', encoding='utf-8') as out:
                json.dump(sorted([list(e) for e in current]), out, ensure_ascii=False, indent=2)
            json.dump({'errors': len(current)}, sys.stdout)
            return
        baseline = {tuple(e) for e in json.load(open(args.baseline, encoding='utf-8'))}
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        sys.stderr.write(f'checks_baseline: {error}\n')
        sys.exit(2)

    result = compare(baseline, current)
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.exit(1 if result['new'] else 0)


if __name__ == '__main__':
    main()
