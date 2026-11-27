#!/usr/bin/env bash
set -euo pipefail

profile=$1
out=.spider/scratch/sparse-hunt
sparse=packages/roam/src/__tests__/sparse-inspection.test.ts
exact=packages/herdr/src/__tests__/roam-exact-launch.test.ts
daemon=packages/herdr/src/__tests__/daemon-cleanup.test.ts
ledger=packages/host/src/usage/__tests__/ledger-v2.test.ts
case "$profile" in
  shard) tests=(--shard=6/12); repetitions=1 ;;
  exact-launch) tests=(--config scripts/sparse-hunt/vitest.config.ts "$sparse" "$exact"); repetitions=8 ;;
  mixed) tests=(--config scripts/sparse-hunt/vitest.config.ts "$sparse" "$daemon" "$ledger"); repetitions=8 ;;
  *) printf 'Unexpected profile: %s\n' "$profile" >&2; exit 2 ;;
esac

failures=0
for ((i=1; i<=repetitions; i++)); do
  stem="$out/$profile-$i"
  echo "::group::$profile repetition $i"
  code=0
  SPARSE_HUNT_RECORD="$PWD/$stem.ndjson" node node_modules/vitest/vitest.mjs run --maxWorkers=2 --reporter=default --reporter=json \
    --outputFile="$stem.json" "${tests[@]}" 2>&1 | tee "$stem.log" || code=$?
  echo "$code" > "$stem.status"
  echo '::endgroup::'
  if (( code != 0 )); then failures=$((failures+1)); fi
done
printf '%s: %s/%s invocations passed\n' "$profile" "$((repetitions-failures))" "$repetitions"
(( failures == 0 ))
