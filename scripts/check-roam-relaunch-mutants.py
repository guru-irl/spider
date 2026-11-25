#!/usr/bin/env python3
"""Run in a git-init copy with --source ORIGINAL --report REPORT -- RUNNER.

RUNNER accepts one test file followed by Vitest arguments and prints its full
log path. No original source is written. Only named assertion failures count.
"""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MUTANTS = [
    ('probe pending ownership before readiness provenance', 'packages/host/src/roam/move-readiness.ts',
     '  const lock = await ports.lock(sessionId), intentOperationId = authority.operationId(sessionId);',
     '  const lock = await ports.lock(sessionId), intentOperationId = authority.operationId(sessionId);\n  if (lock?.pendingOperationId) await ports.probe(sessionId);',
     'packages/host/src/roam/__tests__/roam-move-readiness.test.ts',
     'an unadopted pending handoff has no readiness even with an older receipt: false'),
    ('probe pending ownership before exact launch reconciliation', 'packages/host/src/roam/move-runtime.ts',
     'let owner: Probe = lock?.pendingOperationId ? { kind: "uncertain" } : await probe(home.sessionId);',
     'let owner: Probe = await probe(home.sessionId);',
     'packages/roam/src/__tests__/move-ports.test.ts',
     'destroyed mirror relaunches twice after exact failed launches through production handoff control'),
    ('skip global ownership after cancelling the exact launch', 'packages/host/src/roam/move-runtime.ts',
     '          } else {\n            owner = await probe(home.sessionId);\n            if (owner.kind !== "absent") launchFailure = null;\n          }',
     '          }',
     'packages/roam/src/__tests__/move-ports.test.ts',
     'destroyed mirror relaunches twice after exact failed launches through production handoff control'),
    ('ignore unregistered replacement processes', 'packages/host/src/roam/move-ownership.ts',
     "if (processes.some(row => row.classification !== 'pi' || !row.startIdentity ||",
     "if (false && processes.some(row => row.classification !== 'pi' || !row.startIdentity ||",
     'packages/host/src/__tests__/roam-move-activation.test.ts',
     'an unidentified Pi cannot become an absent owner with no-lock'),
    ('accept readiness from another owner', 'packages/host/src/roam/move-readiness.ts',
     'owner.kind !== "live" || lock.identity.pid !== owner.identity.pid || lock.identity.startIdentity !== owner.identity.startTime) return null;',
     'false) return null;',
     'packages/host/src/roam/__tests__/roam-move-readiness.test.ts',
     'an adopted readiness receipt cannot hide an other-pid owner'),
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command, file, test):
    result = subprocess.run(command + [file, '-t', '^' + re.escape(test) + '$'], cwd=ROOT,
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print(result.stdout, end='')
    match = re.search(r'Full test log: (.+)', result.stdout)
    log_path = Path(match.group(1)) if match else None
    log = log_path.read_text() if log_path else result.stdout
    log = re.sub(r'\x1b\[[0-9;]*m', '', log)
    return result.returncode, log, str(log_path) if log_path else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--report', required=True, type=Path)
    parser.add_argument('runner', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    source = args.source.resolve()
    command = args.runner[1:] if args.runner[:1] == ['--'] else args.runner
    if not command:
        parser.error('Pass the single-file runner command after --.')
    top = subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], cwd=ROOT, text=True).strip()
    has_head = subprocess.run(['git', 'rev-parse', '--verify', 'HEAD'], cwd=ROOT,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if (source == ROOT or source in ROOT.parents or ROOT in source.parents or
            Path(top).resolve() != ROOT or not (ROOT / '.git').is_dir() or has_head):
        raise SystemExit('Refusing mutation: use a separate git-init copy with no commits.')
    files = {item[1] for item in MUTANTS} | {item[4] for item in MUTANTS}
    hashes = {file: digest(source / file) for file in files}
    if any(digest(ROOT / file) != value for file, value in hashes.items()):
        raise SystemExit('The copy differs from the source before mutation.')
    tests = list(dict.fromkeys((item[4], item[5]) for item in MUTANTS))
    results = []
    for file, test in tests:
        code, log, log_path = run(command, file, test)
        if code or not re.search(r'Tests\s+1 passed', log):
            raise SystemExit(f'Baseline did not pass its named test: {test} ({log_path})')
    for name, relative, old, new, file, test in MUTANTS:
        path = ROOT / relative
        original = path.read_bytes()
        text = original.decode()
        if text.count(old) != 1:
            raise SystemExit(f'Missing or ambiguous mutation anchor: {name}')
        try:
            path.write_text(text.replace(old, new))
            code, log, log_path = run(command, file, test)
            named = re.search(r'FAIL\s+[^\n]+ > ' + re.escape(test) + r'(?:\n|$)', log)
            if (not code or not named or 'Test timed out' in log or 'Refusing test run' in log or
                    not re.search(r'(?:AssertionError|OwnershipFailure):', log)):
                raise SystemExit(f'Mutant survived or failed outside its assertion: {name}')
            results.append({'mutant': name, 'source': relative, 'test': test, 'log': log_path, 'result': 'caught'})
            print(f'CAUGHT: {name} | {test}')
        finally:
            path.write_bytes(original)
    for file, test in tests:
        code, log, log_path = run(command, file, test)
        if code or not re.search(r'Tests\s+1 passed', log):
            raise SystemExit(f'Restored source did not pass: {test} ({log_path})')
    if any(digest(source / file) != value or digest(ROOT / file) != value for file, value in hashes.items()):
        raise SystemExit('Source or restored-copy fingerprints changed.')
    args.report.write_text(json.dumps({'results': results, 'sourceUnchanged': True, 'copyRestored': True}, indent=2) + '\n')
    print(f'Caught {len(results)} mutants; original unchanged; restored copy passes.')


if __name__ == '__main__':
    main()
