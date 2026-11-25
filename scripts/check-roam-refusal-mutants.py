#!/usr/bin/env python3
"""Run focused source mutants in a freshly initialized, independent repository copy."""
import argparse
import re
import subprocess
from pathlib import Path

CASES = [
    ("move-step", "packages/roam/src/move.ts",
     'activeStep = name === "check" ? "preflight" : name === "prestage" ? "remote-prepare" : name;',
     'activeStep = "preflight";',
     "packages/roam/src/__tests__/move-finalization.test.ts",
     "names and journals validation refused outside the intercom-blocker adapter"),
    ("move-journal", "packages/roam/src/move.ts",
     'if (ownsOperation) try { ports.journal.record(id, "move-failure", json(failure)); return; }\n    catch { /* An unbegun or completed request needs a separate diagnostic operation. */ }',
     'if (ownsOperation) return;',
     "packages/roam/src/__tests__/first-home-cause.test.ts",
     "reports the machine and kind when a missing mapped store withholds the first home"),
    ("move-public-detail", "packages/roam/src/commands.ts",
     'const failure = result.code !== 0 && Object.hasOwn(MOVE_REFUSAL_MESSAGES, result.reason) ||',
     'const failure = result.code !== 0 && result.reason.startsWith("move-") ||',
     "packages/roam/src/__tests__/move-refusal.test.ts",
     "names and journals the disabled refusal without reserving the session"),
    ("move-conflict-isolation", "packages/roam/src/move.ts",
     'const ownsOperation = isDeepStrictEqual(rows.find(row => row.action === "move-request")?.result, json(request));',
     'const ownsOperation = true;',
     "packages/roam/src/__tests__/move-refusal.test.ts",
     "journals a conflicting request separately without changing the original operation"),
    ("retire-proof", "packages/roam/src/store-retire.ts",
     'if (!retired.has(meta.machine_id)) { unavailable("machine-not-retired"); continue; }',
     'if (false) { unavailable("machine-not-retired"); continue; }',
     "packages/roam/src/__tests__/store-retire.test.ts",
     "refuses an unknown foreign owner even with confirmation"),
    ("retire-confirm", "packages/roam/src/store-retire.ts",
     'if (!confirm) return result;',
     'if (false) return result;',
     "packages/roam/src/__tests__/store-retire.test.ts",
     "previews and retires a foreign registration only with durable destroyed-machine proof"),
    ("retire-audit", "packages/roam/src/store-retire.ts",
     'if (audit.length) writeLocal(db, "store-retire", randomUUID(), { removed: audit });',
     'if (false) writeLocal(db, "store-retire", randomUUID(), { removed: audit });',
     "packages/roam/src/__tests__/store-retire.test.ts",
     "previews and retires a foreign registration only with durable destroyed-machine proof"),
    ("retire-dependent-repository", "packages/roam/src/store-retire.ts",
     'const check = candidate.table === "projects" && !candidate.repository ? protectedProjects.get(String(candidate.row.project_key)) : undefined;',
     'const check: string | undefined = undefined;',
     "packages/roam/src/__tests__/store-retire.test.ts",
     "retains a foreign project when deleting it would drop a repository required by a current home"),
    ("retire-plain-doctor", "packages/roam/src/store-inventory.ts",
     'run ${problem.machineId ? `spider roam stores retire ${problem.machineId}` : "the repair command"} on the hub',
     'run the repair on the hub',
     "packages/roam/src/__tests__/store-retire.test.ts",
     "plain doctor names the exact hub retirement command"),
    ("retire-hub-authority", "packages/roam/src/agent.ts",
     'ports.config.role !== "box" || args.sourceMachine !== ports.config.hubMachineId ||',
     'ports.config.role !== "box" || false ||',
     "packages/roam/src/__tests__/store-retire.test.ts",
     "refuses a retirement attestation from anyone other than the enrolled hub"),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--runner", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root, runner, output = args.root.resolve(), args.runner.resolve(), args.output.resolve()
    if not (root / ".git").is_dir() or (root / ".git").is_symlink():
        parser.error("The copy must have its own initialized .git directory, not a worktree pointer")
    top = subprocess.check_output(["git", "-C", str(root), "rev-parse", "--show-toplevel"], text=True).strip()
    if Path(top).resolve() != root:
        parser.error("The copy is not its own repository root")
    if subprocess.run(["git", "-C", str(root), "rev-parse", "--verify", "HEAD"], capture_output=True).returncode == 0:
        parser.error("Refusing to mutate a repository with committed history; use a fresh independent copy")
    if not runner.is_file():
        parser.error("The single-file test runner is missing")
    output.mkdir(parents=True, exist_ok=True)
    summary = output / "results.tsv"
    summary.write_text("case\tresult\ttest\tlog\n")
    originals = {source: (root / source).read_text() for _, source, *_ in CASES}
    for name, source, old, _, _, _ in CASES:
        if originals[source].count(old) != 1:
            parser.error(f"{name}: the source anchor must match exactly once")

    def run(label, test, name):
        result = subprocess.run(["bash", str(runner), test, "-t", f"^{re.escape(name)}$"],
                                cwd=root, capture_output=True, text=True)
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
            file.write_text(originals[source].replace(old, new))
            code, text, log = run(case, test, name)
            killed = code != 0 and f"FAIL  {test} > {name}" in text
            status = "KILLED" if killed else "SURVIVED" if code == 0 else "ERROR"
            with summary.open("a") as out:
                out.write(f"{case}\t{status}\t{name}\t{log}\n")
            print(f"{case}: {status} by {name}", flush=True)
            if not killed:
                raise RuntimeError(f"The named test did not catch {case}: {log}")
        finally:
            file.write_text(originals[source])
    print(f"{len(CASES)}/{len(CASES)} mutants caught; all source files restored. Evidence: {summary}")


if __name__ == "__main__":
    main()
