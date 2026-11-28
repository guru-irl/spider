#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 3 ]]; then
  echo 'usage: profile-loaded.sh <tools-root> <output-dir> <expected-files>' >&2
  exit 2
fi
tools=$1
out=$2
expected=$3
mkdir -p "$out" "$PWD/.spider/scratch/tmp"
p=packages/herdr/src/__tests__
shopt -s nullglob
files=("$p"/setup-checkpoint-model-seed*.test.ts "$p"/checkpoint-model-shards*.test.ts
  "$p"/remote-execute*.test.ts "$p"/production-cutover-{rollback,placement,launcher,journal}*.test.ts
  "$p"/production-cutover-app-shim*.test.ts "$p"/spaces-a-install*.test.ts
  "$p"/setup-backup-recovery*.test.ts "$p"/setup-installation*.test.ts
  "$p"/setup-checkpoint.test.ts "$p"/setup-checkpoint-part*.test.ts "$p"/acceptance.test.ts
  "$p"/acceptance-remote*.test.ts "$p"/acceptance-setup*.test.ts "$p"/packaging*.test.ts
  "$p"/child-remote-integration*.test.ts "$p"/child-remote-handoff*.test.ts
  "$p"/spaces.test.ts "$p"/pane-roaming-handoff*.test.ts
  "$p"/agent-consoles*.test.ts "$p"/ssh-core-restart.test.ts "$p"/console-upgrade.test.ts)
if [[ ${#files[@]} -ne $expected ]]; then echo "Expected $expected files, found ${#files[@]}" >&2; exit 1; fi
for file in "${files[@]}"; do test -f "$file" || { echo "Missing $file" >&2; exit 1; }; done
printf '%s\n' "${files[@]}" > "$out/file-list.txt"
if [[ $(sort -u "$out/file-list.txt" | wc -l) -ne ${#files[@]} ]]; then echo 'Duplicate test file' >&2; exit 1; fi
printf 'head %s\nstarted %s\n' "$(git rev-parse HEAD)" "$(date -u +%FT%TZ)" > "$out/identity.txt"
export TMPDIR="$PWD/.spider/scratch/tmp" SPIDER_TEST_SEED=182 WPKG_LIFECYCLE_REPORT="$out/lifecycle.json"
unset XDG_RUNTIME_DIR PI_SUBAGENT_CHILD PI_SUBAGENT_RUN_ID PI_SPIDER_DB_PATH PI_SPIDER_SESSION_ID SPIDER_HERDR_E2E SPIDER_HERDR_APP_TESTS SPIDER_HERDR_APP_E2E NODE_OPTIONS WPKG_PROFILE_LOG || true
result=0
/usr/bin/time -f 'real %e\nuser %U\nsys %S' -o "$out/loaded.time" \
  node node_modules/vitest/vitest.mjs run "${files[@]}" --maxWorkers=3 --reporter=json \
  --reporter="$tools/scripts/wpkg-speed/lifecycle-reporter.mjs" --outputFile.json="$out/loaded.json" >"$out/loaded.log" 2>&1 || result=1
if [[ $result == 0 ]]; then
  node "$tools/scripts/wpkg-speed/lifecycle-summary.mjs" "$out/lifecycle.json" "$out/loaded.json" "$out/file-list.txt" --report-only | tee "$out/lifecycle-summary.txt" || result=1
else
  tail -100 "$out/loaded.log"
fi
printf 'finished %s\nresult %s\n' "$(date -u +%FT%TZ)" "$result" >> "$out/identity.txt"
exit "$result"
