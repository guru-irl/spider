#!/usr/bin/env python3
"""Check move repair mutants in a fresh, independent repository copy."""
import argparse
import re
import subprocess
from pathlib import Path

PORT_TEST = "packages/roam/src/__tests__/move-ports.test.ts"
SUPERVISOR_TEST = "packages/roam/src/__tests__/participant-runtime.test.ts"
START_TEST = "packages/roam/src/__tests__/move-finalization.test.ts"
SHARED = "no shared destination history refuses with a fetch instruction before freeze and leaves home unchanged"
REMOTE = "remote prerequisite refusal reaches the public move with safe guidance: fetch the required commits on both machines"
SUPERVISOR = "destination preflight refuses a same-named supervisor on another root before freeze or home CAS"
START = "a supervisor start refusal retains its code and provisioning repair after home commit"
INVALID = "invalid merge base names its refusal and Git repair before freeze"

CASES = [
    ("missing-cause", "packages/roam/src/move-failure.ts",
     '"workspace-prerequisite-missing", "workspace-prerequisite-invalid", "workspace-fetch-unavailable"] as const;',
     '"workspace-prerequisite-invalid", "workspace-fetch-unavailable"] as const;', PORT_TEST, SHARED),
    ("remote-hint", "packages/roam/src/agent.ts",
     'cause === "workspace-prerequisite-missing" ? prerequisiteRepair(error) : "spider roam doctor"',
     '"spider roam doctor"', PORT_TEST, REMOTE),
    ("adapter-hint", "packages/roam/src/move-ports.ts",
     'code === "workspace-prerequisite-missing" ? safeMoveRepair(code, outcome.repairCommand) : undefined',
     'undefined', PORT_TEST, REMOTE),
    ("provision-repair", "packages/roam/src/move-failure.ts",
     'if (isSupervisorMoveCause(cause) && isMachineId(destinationMachine)) return `spider roam provision ${destinationMachine}`;',
     'if (isSupervisorMoveCause(cause)) return "spider roam doctor";', SUPERVISOR_TEST, SUPERVISOR),
    ("start-refusal", "packages/roam/src/move.ts",
     'if (cause && isSupervisorMoveCause(cause)) throw Object.assign(new MoveError("move-destination-pending"),',
     'if (false && cause && isSupervisorMoveCause(cause)) throw Object.assign(new MoveError("move-destination-pending"),', START_TEST, START),
    ("invalid-base", "packages/roam/src/git-bundle.ts",
     'if (!bases.every(base => oid.test(base))) throw new WorkspacePrerequisiteError("verify the Git history on both machines", "workspace-prerequisite-invalid");',
     'if (!bases.every(base => oid.test(base))) throw new Error("workspace-prerequisite-invalid");', PORT_TEST, INVALID),
    ("public-hint", "packages/roam/src/commands.ts",
     'moveCause !== undefined && safeMoveRepair(moveCause, value) === value || ',
     '', PORT_TEST, REMOTE),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--runner", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root, runner, output = args.root.resolve(), args.runner.resolve(), args.output.resolve()
    if not (root / ".git").is_dir() or (root / ".git").is_symlink():
        parser.error("The copy needs its own initialized .git directory")
    top = subprocess.check_output(["git", "-C", str(root), "rev-parse", "--show-toplevel"], text=True).strip()
    if Path(top).resolve() != root or subprocess.run(["git", "-C", str(root), "rev-parse", "--verify", "HEAD"], capture_output=True).returncode == 0:
        parser.error("Use a fresh independent copy without committed history")
    if not runner.is_file():
        parser.error("The single-file test runner is missing")
    originals = {source: (root / source).read_bytes() for _, source, *_ in CASES}
    for name, source, old, _, _, _ in CASES:
        if originals[source].count(old.encode()) != 1:
            parser.error(f"{name}: source anchor must match exactly once")
    output.mkdir(parents=True, exist_ok=True)
    summary = output / "results.tsv"
    summary.write_text("case\tresult\ttest\tlog\n")

    def run(label, test, name):
        result = subprocess.run(["bash", str(runner), test, "-t", f"^{re.escape(name)}$"], cwd=root, capture_output=True, text=True)
        log = output / f"{label}.log"
        log.write_text(result.stdout + result.stderr)
        match = re.search(r"Full test log: (.+)", result.stdout)
        full = Path(match.group(1)).read_text(errors="replace") if match else result.stdout + result.stderr
        return result.returncode, re.sub(r"\x1b\[[0-9;]*m", "", full), log

    controls = set()
    for case, source, old, new, test, name in CASES:
        if (test, name) not in controls:
            code, text, log = run(f"control-{case}", test, name)
            if code or not re.search(r"Tests\s+1 passed", text):
                raise RuntimeError(f"Control failed or selected no test: {log}")
            controls.add((test, name))
        file = root / source
        try:
            file.write_bytes(originals[source].replace(old.encode(), new.encode()))
            code, text, log = run(case, test, name)
            killed = code != 0 and f"FAIL  {test} > {name}" in text
            status = "KILLED" if killed else "SURVIVED" if code == 0 else "ERROR"
            with summary.open("a") as out:
                out.write(f"{case}\t{status}\t{name}\t{log}\n")
            print(f"{case}: {status} by {name}", flush=True)
            if not killed:
                raise RuntimeError(f"The named test did not catch {case}: {log}")
        finally:
            file.write_bytes(originals[source])
    if any((root / source).read_bytes() != content for source, content in originals.items()):
        raise RuntimeError("A source file was not restored")
    print(f"{len(CASES)}/{len(CASES)} mutants caught; source restored. Evidence: {summary}")


if __name__ == "__main__":
    main()
