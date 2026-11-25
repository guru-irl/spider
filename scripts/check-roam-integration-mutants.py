#!/usr/bin/env python3
"""Check integrated move/CLI contracts with source mutants in an independent copy."""
import argparse
import re
import subprocess
from pathlib import Path

MOVE_TEST = "packages/roam/src/__tests__/move-ports.test.ts"
MOVE_NAME = "move reports the failing workspace-plan adapter without exposing error text"
CLI_TEST = "packages/roam/src/__tests__/cli-controls.test.ts"
CLI_NAME = "disabled doctor names a foreign-machine mapped worktree and targets its catalog for repair"
CASES = [
    ("missing-refusal-journal", "packages/roam/src/move.ts",
     'if (!ports.journal.read(diagnosticId).some(row => row.action === "move-failure"))',
     'if (false)', MOVE_TEST, MOVE_NAME, 4),
    ("unaccepted-request-pollution", "packages/roam/src/move.ts",
     'const ownsOperation = isDeepStrictEqual(rows.find(row => row.action === "move-request")?.result, json(request));',
     'const ownsOperation = true;', MOVE_TEST, MOVE_NAME, 4),
    ("private-adapter-code", "packages/roam/src/move-failure.ts",
     '(value === "unknown" || Object.hasOwn(MOVE_REFUSAL_MESSAGES, value) || safeMoveCause(value) !== undefined || safeCauseCode(value) !== undefined);',
     'true;', MOVE_TEST, MOVE_NAME, 4),
    ("missing-catalog-repair", "packages/roam/src/store-inventory.ts",
     ': problem.check === "store-machine-mismatch" && problem.machineId ? `spider roam stores retire ${problem.machineId}`',
     ': problem.check === "store-machine-mismatch" && problem.machineId ? "spider roam doctor"',
     CLI_TEST, CLI_NAME, 1),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--runner", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root, runner, output = args.root.resolve(), args.runner.resolve(), args.output.resolve()
    if not (root / ".git").is_dir() or (root / ".git").is_symlink():
        parser.error("Use an independent copy with its own initialized .git directory")
    top = subprocess.check_output(["git", "-C", str(root), "rev-parse", "--show-toplevel"], text=True).strip()
    if Path(top).resolve() != root:
        parser.error("The copy is not its own repository root")
    if subprocess.run(["git", "-C", str(root), "rev-parse", "--verify", "HEAD"], capture_output=True).returncode == 0:
        parser.error("Refusing to mutate committed history; use a fresh independent copy")
    if not runner.is_file():
        parser.error("The single-file runner is missing")
    originals = {source: (root / source).read_text() for _, source, *_ in CASES}
    for name, source, old, *_ in CASES:
        if originals[source].count(old) != 1:
            parser.error(f"{name}: source anchor must match exactly once")
    output.mkdir(parents=True, exist_ok=True)
    summary = output / "results.tsv"
    summary.write_text("case\tresult\ttest\tlog\n")

    def run(label, test, name):
        result = subprocess.run(["bash", str(runner), test, "-t", f"^{re.escape(name)}$"],
                                cwd=root, capture_output=True, text=True)
        log = output / f"{label}.log"
        log.write_text(result.stdout + result.stderr)
        match = re.search(r"Full test log: (.+)", result.stdout)
        full = Path(match.group(1)).read_text(errors="replace") if match else result.stdout + result.stderr
        return result.returncode, re.sub(r"\x1b\[[0-9;]*m", "", full), log

    controls = set()
    for case, source, old, new, test, name, count in CASES:
        if (test, name) not in controls:
            code, text, log = run(f"control-{case}", test, name)
            if code or not re.search(rf"Tests\s+{count} passed", text):
                raise RuntimeError(f"Control failed or selected the wrong tests: {log}")
            controls.add((test, name))
        file = root / source
        try:
            file.write_text(originals[source].replace(old, new))
            code, text, log = run(case, test, name)
            killed = code != 0 and f"FAIL  {test} > {name}" in text
            status = "KILLED" if killed else "SURVIVED" if code == 0 else "ERROR"
            with summary.open("a") as out:
                out.write(f"{case}\t{status}\t{name}\t{log}\n")
            print(f"{case}: {status} by {name}", flush=True)
            if not killed:
                raise RuntimeError(f"The named assertion did not catch {case}: {log}")
        finally:
            file.write_text(originals[source])
    for source, original in originals.items():
        if (root / source).read_text() != original:
            raise RuntimeError(f"Source not restored: {source}")
    print(f"{len(CASES)}/{len(CASES)} mutants caught; source restored. Evidence: {summary}")


if __name__ == "__main__":
    main()
