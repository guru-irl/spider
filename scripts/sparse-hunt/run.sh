#!/usr/bin/env bash
set -euo pipefail

profile=$1
out=.spider/scratch/sparse-hunt
sparse=packages/roam/src/__tests__/sparse-inspection.test.ts
exact=packages/herdr/src/__tests__/roam-exact-launch.test.ts
daemon=packages/herdr/src/__tests__/daemon-cleanup.test.ts
ledger=packages/host/src/usage/__tests__/ledger-v2.test.ts
runner=(node)
case "$profile" in
  shard) tests=(--shard=6/12); repetitions=1; arms=(fixed) ;;
  exact-launch) tests=(--config scripts/sparse-hunt/vitest.config.ts "$sparse" "$exact"); repetitions=8; arms=(base fixed) ;;
  mixed|pinned-mixed)
    tests=(--config scripts/sparse-hunt/vitest.config.ts "$sparse" "$daemon" "$ledger"); repetitions=8; arms=(base fixed)
    if [[ "$profile" == pinned-mixed ]]; then
      allowed=$(taskset -pc $$); first=${allowed##* }; first=${first%%[,-]*}
      runner=(taskset -c "$first" node)
    fi ;;
  *) printf 'Unexpected profile: %s\n' "$profile" >&2; exit 2 ;;
esac

product=packages/roam/src/workspace-import.ts
baseline=b54686bee88da85feefb64055f198d237c2eec76
head=$(git rev-parse HEAD)
git show "$baseline:$product" > "$out/base.ts"
git show "$head:$product" > "$out/fixed.ts"
# Restore the experiment file even if a test invocation fails.
trap 'cp "$out/fixed.ts" "$product"' EXIT

failures=0
for ((i=1; i<=repetitions; i++)); do
  order=("${arms[@]}")
  if (( i % 2 == 0 )) && [[ ${#arms[@]} == 2 ]]; then order=(fixed base); fi
  for arm in "${order[@]}"; do
    cp "$out/$arm.ts" "$product"
    stem="$out/$profile-$arm-$i"
    echo "::group::$profile $arm repetition $i"
    code=0
    SPARSE_HUNT_RECORD="$PWD/$stem.ndjson" "${runner[@]}" node_modules/vitest/vitest.mjs run --maxWorkers=2 --reporter=default --reporter=json \
      --outputFile="$stem.json" "${tests[@]}" 2>&1 | tee "$stem.log" || code=$?
    echo "$code" > "$stem.status"
    echo '::endgroup::'
    if (( code != 0 )); then failures=$((failures+1)); fi
  done
done
runs=$((repetitions * ${#arms[@]}))
printf '%s: %s/%s invocations passed\n' "$profile" "$((runs-failures))" "$runs"
(( failures == 0 ))
