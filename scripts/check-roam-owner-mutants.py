#!/usr/bin/env python3
"""Run in a fresh, uncommitted copy with --source ORIGINAL -- RUNNER.

RUNNER must accept a test file followed by Vitest arguments. The original
checkout is read-only. Every mutant is restored before the next test run.
"""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MUTANTS = [
    ('omit normal-runtime registrations', 'packages/host/src/roam/move-runtime.ts',
     "createProcessInventory(join(root, \"herdr\"), false, [join(homedir(), '.pi', 'agent', 'spider', 'herdr')])",
     'createProcessInventory(join(root, "herdr"))',
     'packages/host/src/__tests__/roam-move-activation.test.ts',
     'the production move probe accounts for an unrelated Pi registered in the normal runtime'),
    ('ignore unidentified replacement owners', 'packages/host/src/roam/move-ownership.ts',
     "if (processes.some(row => row.classification !== 'pi' || !row.startIdentity ||",
     "if (false && processes.some(row => row.classification !== 'pi' || !row.startIdentity ||",
     'packages/host/src/__tests__/roam-move-activation.test.ts',
     'an unidentified Pi cannot become an absent owner with no-lock'),
    ('claim absence without boot evidence', 'packages/host/src/roam/move-ownership.ts',
     "if (!bootId || !lock.bootId) throw new OwnershipFailure('ownership-boot-unavailable');",
     "if (!bootId || !lock.bootId) return { kind: 'absent' };",
     'packages/host/src/__tests__/roam-move-activation.test.ts',
     'a missing boot identity never proves a matching live lock absent'),
    ('keep a stale reused-PID file lease blocking', 'packages/herdr/src/sessions/lease.ts',
     "if (p.kind === 'unknown') uncertain.push(lease.pid); else if (p.kind === 'live' && p.startIdentity === lease.startIdentity) live.push(lease.pid);",
     "if (p.kind === 'unknown' || p.kind === 'live' && p.startIdentity !== lease.startIdentity) uncertain.push(lease.pid); else if (p.kind === 'live') live.push(lease.pid);",
     'packages/host/src/herdr/__tests__/roam-owner-inventory.test.ts',
     'a stale file lease does not block absence when its reused PID is proved unrelated'),
    ('discard the ownership refusal cause', 'packages/roam/src/move-recovery.ts',
     'const ownershipCause = blockers.map(ownershipFailureCode).find(cause => cause !== undefined);',
     'const ownershipCause = undefined;',
     'packages/roam/src/__tests__/unfrozen-move.test.ts',
     'cancel names the ownership repair instead of a cancel/recover loop'),
    ('inspect service paths before refusing a pending move', 'packages/roam/src/production-controls.ts',
     'const pendingMove = readPendingMoves(journalFile)?.[0];',
     'assertTestConfigPath(hubServiceFile(root, join(homedir(), "Library", "LaunchAgents")));\n      const pendingMove = readPendingMoves(journalFile)?.[0];',
     'packages/roam/src/__tests__/unfrozen-move.test.ts',
     'pending-move disable refuses before linux service-path inspection'),
    ('make pending moves nonblocking in doctor', 'packages/roam/src/local-diagnostics.ts',
     'else for (const move of moves) inventory.push({ severity: "block", reason:',
     'else for (const move of moves) inventory.push({ severity: "warning", reason:',
     'packages/roam/src/__tests__/unfrozen-move.test.ts',
     'disabled public doctor still lists pending moves'),
    ('drop the disconnected hub repair', 'packages/roam/src/cli.ts',
     "{ ...outcome(1, \"move-control-unavailable\"), repairCommand: 'spider roam enable' }",
     'outcome(1, "move-control-unavailable")',
     'packages/roam/src/__tests__/unfrozen-move.test.ts',
     'cancel with unavailable move control names enable in JSON and text output: json=true'),
    ('leave reused-PID ID mutex tickets blocking', 'packages/herdr/src/sessions/id-lock.ts',
     'return operation();\n    }, { reclaimReusedOwner: true });',
     'return operation();\n    });',
     'packages/host/src/herdr/__tests__/roam-owner-inventory.test.ts',
     'a stale session-id mutex ticket with a reused PID does not block a proved unrelated replacement'),
    ('leave reused-PID file mutex tickets blocking', 'packages/herdr/src/sessions/lease.ts',
     "} : policy?.mode === 'cutover' ? { reclaimReusedOwner: true } : {}); }",
     '} : {}); }',
     'packages/host/src/herdr/__tests__/roam-owner-inventory.test.ts',
     'a stale file-lease mutex ticket with a reused PID does not block a proved unrelated replacement'),
    ('reclaim a matching live ticket owner', 'packages/herdr/src/sessions/registry.ts',
     "observed.kind === 'live' && observed.startIdentity !== ticket.startIdentity)",
     "observed.kind === 'live')",
     'packages/host/src/herdr/__tests__/roam-owner-inventory.test.ts',
     'a session-id mutex ticket keeps a matching possibly-same owner blocking'),
    ('reclaim an unreadable ticket owner', 'packages/herdr/src/sessions/registry.ts',
     "if (observed.kind === 'absent' || options.reclaimReusedOwner",
     "if (observed.kind === 'absent' || observed.kind === 'unknown' || options.reclaimReusedOwner",
     'packages/host/src/herdr/__tests__/roam-owner-inventory.test.ts',
     'a session-id mutex ticket keeps a unknown possibly-same owner blocking'),
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command, file, test=None):
    args = command + [file] + ([] if test is None else ['-t', re.escape(test)])
    result = subprocess.run(args, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print(result.stdout, end='')
    match = re.search(r'Full test log: (.+)', result.stdout)
    log_path = Path(match.group(1)) if match else None
    log = log_path.read_text() if log_path else result.stdout
    return result.returncode, log, str(log_path) if log_path else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--report', type=Path)
    parser.add_argument('runner', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    source = args.source.resolve()
    command = args.runner[1:] if args.runner[:1] == ['--'] else args.runner
    if not command:
        parser.error('Pass the single-file runner command after --.')
    top = subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], cwd=ROOT, text=True).strip()
    has_head = subprocess.run(['git', 'rev-parse', '--verify', 'HEAD'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if source == ROOT or source in ROOT.parents or ROOT in source.parents or Path(top).resolve() != ROOT or not (ROOT/'.git').is_dir() or has_head:
        raise SystemExit('Refusing mutation: use a separate git-init copy with no commits, never a worktree or normal checkout.')
    hashes = {relative: digest(source/relative) for _, relative, *_ in MUTANTS}
    if any(digest(ROOT/relative) != value for relative, value in hashes.items()):
        raise SystemExit('The copy differs from the source before mutation.')
    results = []
    files = list(dict.fromkeys(item[4] for item in MUTANTS))
    for file in files:
        code, _, log = run(command, file)
        if code:
            raise SystemExit(f'Baseline failed; mutations are inconclusive: {file} ({log})')
    for name, relative, old, new, file, test in MUTANTS:
        path = ROOT/relative
        original = path.read_bytes()
        text = original.decode()
        if text.count(old) != 1:
            raise SystemExit(f'Missing or ambiguous mutation anchor: {name}')
        try:
            path.write_text(text.replace(old, new))
            code, log, log_path = run(command, file, test)
            named_failure = re.search(r'FAIL\s+[^\n]+ > ' + re.escape(test), log)
            if not code or not named_failure or 'Test timed out' in log or 'Refusing test run' in log:
                raise SystemExit(f'Mutant survived or failed outside its named test: {name}')
            results.append({'mutant':name, 'source':relative, 'test':test, 'log':log_path, 'result':'caught'})
            print(f'CAUGHT: {name} | {test}')
        finally:
            path.write_bytes(original)
    for file in files:
        code, _, log = run(command, file)
        if code:
            raise SystemExit(f'Restored source failed: {file} ({log})')
    if any(digest(source/relative) != value or digest(ROOT/relative) != value for relative, value in hashes.items()):
        raise SystemExit('Source or restored-copy fingerprints changed.')
    if args.report:
        args.report.write_text(json.dumps({'results':results, 'sourceUnchanged':True, 'copyRestored':True}, indent=2)+'\n')
    print(f'Caught {len(results)} mutants; original unchanged; restored copy passes.')


if __name__ == '__main__':
    main()
