#!/usr/bin/env python3
"""Run in an independent, uncommitted copy: --source ORIGINAL -- RUNNER.

RUNNER accepts one test file followed by Vitest arguments. Prepare the copy
with cp -cR, remove only its copied .git file, and run git init there.
The original repository is read-only. Each mutant is restored before exit.
"""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST = "packages/roam/src/__tests__/retired-session-install.test.ts"
MUTANTS = [
    ("compare the whole retired history", "packages/roam/src/session-file.ts",
     "const length = (retired?.size ?? prior.manifest.size) - prior.headerBytes;",
     "const length = prior.manifest.size - prior.headerBytes;",
     "return installs committed history and backs up discarded retired metadata"),
    ("ignore the frozen prefix digest", "packages/roam/src/session-file.ts",
     "digestRange(target, 0, retired.size) !== retired.sha256", "false",
     "return refuses a committed rewrite even when incoming history matches it"),
    ("discard retired metadata without a backup", "packages/roam/src/session-file.ts",
     "ensureBackup(target, backup, prior.manifest);", "// mutant: no private backup",
     "return installs committed history and backs up discarded retired metadata"),
    ("accept an unfinished retirement", "packages/roam/src/journal.ts",
     "f.state='complete'", "f.state IN ('frozen','complete')",
     "return does not discard appends from a freeze whose retirement is unfinished"),
    ("prune the retired prefix acknowledgement", "packages/roam/src/journal.ts",
     "WHERE o.operation_id=? AND f.state IN ('frozen','complete')",
     "WHERE 0 AND o.operation_id=? AND f.state IN ('frozen','complete')",
     "return retains its frozen prefix proof after journal retention expires"),
    ("force the first freeze epoch", "packages/roam/src/session-file.ts",
     "departure.epoch - 1", "1",
     "return uses the freeze epoch after rollback without requiring a new source segment"),
    ("trim a newer installed copy using an old departure", "packages/roam/src/session-file.ts",
     "departure && (prior.lastSegment?.epoch ?? 0) < departure.epoch", "departure",
     "retrying an earlier return cannot discard appends from the newer installed copy"),
    ("borrow retirement proof from another move", "packages/roam/src/journal.ts",
     "f.move_id=? AND f.epoch=?", "(? IS NOT NULL) AND f.epoch=?",
     "return cannot borrow retirement proof from a different departure at the same epoch"),
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command, test=None):
    args = command + [TEST] + ([] if test is None else ["-t", re.escape(test)])
    result = subprocess.run(args, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print(result.stdout, end="")
    match = re.search(r"Full test log: (.+)", result.stdout)
    if not match:
        raise SystemExit("The runner produced no test log; the result is inconclusive.")
    path = Path(match.group(1))
    return result.returncode, path.read_text(), str(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("runner", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    source = args.source.resolve()
    command = args.runner[1:] if args.runner[:1] == ["--"] else args.runner
    if not command:
        parser.error("Pass the single-file runner command after --.")
    top = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], cwd=ROOT, text=True).strip()).resolve()
    has_head = subprocess.run(["git", "rev-parse", "--verify", "HEAD"], cwd=ROOT,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if source == ROOT or source in ROOT.parents or ROOT in source.parents or top != ROOT or not (ROOT / ".git").is_dir() or has_head:
        raise SystemExit("Refusing mutation: use a separate git-init copy without commits, not a worktree or normal checkout.")
    paths = {TEST, *(item[1] for item in MUTANTS)}
    hashes = {relative: digest(source / relative) for relative in paths}
    if any(digest(ROOT / relative) != value for relative, value in hashes.items()):
        raise SystemExit("The copy differs from the original before mutation.")
    code, log, baseline = run(command)
    if code or not re.search(r"Test Files\s+1 passed", log):
        raise SystemExit(f"Baseline failed; mutations are inconclusive: {baseline}")
    results = []
    for name, relative, old, new, test in MUTANTS:
        path = ROOT / relative
        original = path.read_bytes()
        text = original.decode()
        if text.count(old) != 1:
            raise SystemExit(f"Missing or ambiguous mutation anchor: {name}")
        try:
            path.write_text(text.replace(old, new))
            code, log, log_path = run(command, test)
            failure = re.search(r"FAIL\s+" + re.escape(TEST) + r" > " + re.escape(test) + r"\s*\n", log)
            if not code or not failure or not re.search(r"Test Files\s+1 failed", log) or re.search(r"timed out|Refusing test run|Unhandled Errors|Failed Suites", log, re.I):
                raise SystemExit(f"Mutant survived or failed outside its named test: {name}")
            results.append({"mutant": name, "source": relative, "test": test, "log": log_path, "result": "caught"})
            print(f"CAUGHT: {name} | {test}")
        finally:
            path.write_bytes(original)
    code, log, restored = run(command)
    if code or not re.search(r"Test Files\s+1 passed", log):
        raise SystemExit(f"Restored source failed: {restored}")
    if any(digest(source / relative) != value or digest(ROOT / relative) != value for relative, value in hashes.items()):
        raise SystemExit("Original or restored-copy fingerprints changed.")
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps({"baseline": baseline, "results": results, "restored": restored,
                                       "sourceUnchanged": True, "copyRestored": True}, indent=2) + "\n")
    print(f"Caught {len(results)} mutants; original unchanged; restored copy passes.")


if __name__ == "__main__":
    main()
