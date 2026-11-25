#!/usr/bin/env python3
"""Run from an isolated checkout, passing the single-file test runner command.

The runner must accept Vitest's -t option. Each source mutation is restored
before the next run, including when a command fails. Never run this beside
another writer or a process that consumes the checkout's source files.
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MUTANTS = [
    ("bypass frozen abort authorization", "packages/host/src/roam/freeze.ts",
     'if (!proof || proof.cancelledMoveId !== key.moveId || !proof.home || proof.home.sessionId !== key.sessionId ||\n        proof.home.machineId !== operation.machineId || proof.home.epoch !== key.epoch) {',
     'if (false) {', "a completed freeze still requires abort authorization"),
    ("leave the intake fence closed", "packages/host/src/roam/freeze.ts",
     'if (fence) await intercomPorts(ports, key).ports.abort(fence);',
     'if (false && fence) await intercomPorts(ports, key).ports.abort(fence);',
     "cancel clears a partial fenced freeze"),
    ("drop the move ID from disable reason", "packages/roam/src/production-controls.ts",
     'reason: `move-in-progress:${pendingMove.operationId}`', 'reason: "move-in-progress"',
     "disable names the pending move"),
    ("hide pending moves from doctor", "packages/roam/src/local-diagnostics.ts",
     'else for (const move of moves) inventory.push', 'else for (const move of []) inventory.push',
     "doctor lists every pending move"),
    ("discard the cancel adapter blockers", "packages/roam/src/move-recovery.ts",
     'const blockers = error instanceof MoveError ? error.refusal.blockers : cause ? [validateBlockerId(cause)] : [];',
     'const blockers = [];', "cancel retains the adapter cause"),
    ("require freeze progress before cancel", "packages/host/src/roam/freeze.ts",
     'if (progress && (progress.epoch !== key.epoch || progress.state === "complete"))',
     'if (!progress || progress.epoch !== key.epoch || progress.state === "complete")',
     "cancel completes when freeze refused before participant progress existed"),
]


def run(command):
    result = subprocess.run(command, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print(result.stdout, end="")
    log = result.stdout
    match = re.search(r"Full test log: (.+)", log)
    if match:
        log = Path(match.group(1)).read_text()
    return result.returncode, log


def main():
    command = sys.argv[1:]
    if not command:
        raise SystemExit("Pass a single-file Vitest runner command.")
    code, _ = run(command)
    if code:
        raise SystemExit("Baseline failed; mutation results would be inconclusive.")
    for name, relative, old, new, test in MUTANTS:
        source = ROOT / relative
        original = source.read_bytes()
        text = original.decode()
        if text.count(old) != 1:
            raise SystemExit(f"Mutation anchor is missing or ambiguous: {name}")
        try:
            source.write_text(text.replace(old, new))
            code, log = run(command + ["-t", test])
            if not code or "AssertionError" not in log or test not in log:
                raise SystemExit(f"Mutant survived or failed outside its assertion: {name}")
            print(f"CAUGHT: {name} | {test}")
        finally:
            source.write_bytes(original)
    code, _ = run(command)
    if code:
        raise SystemExit("Restored-source verification failed.")
    print(f"Caught {len(MUTANTS)} mutants; restored source passes.")


if __name__ == "__main__":
    main()
