#!/usr/bin/env bash
set -euo pipefail

lane=$1
phase=$2
dir=packages/host/src/__tests__
files=(herdr-setup-fixture.ts herdr-setup-releases.test.ts)
snapshots=.spider/scratch/hsr-snapshots
export TMPDIR="$PWD/.spider/scratch/tmp"
unset XDG_RUNTIME_DIR

if [[ "$phase" == first || "$phase" == after-first ]]; then
  mkdir -p "$snapshots"/{base,after} hsr-results/{base,after}
  for file in "${files[@]}"; do
    git show "9df6bb7ce:$dir/$file" > "$snapshots/base/$file"
    cp "$dir/$file" "$snapshots/after/$file"
  done
fi

restore() {
  for file in "${files[@]}"; do cp "$snapshots/$1/$file" "$dir/$file"; done
}
trap 'restore after' EXIT

trial() {
  local variant=$1 ordinal=$2 rc=0 output="hsr-results/$1/$lane-$2"
  restore "$variant"
  npx vitest run --maxWorkers=3 --reporter=default --reporter=json \
    --outputFile="$output.json" "$dir/herdr-setup-releases.test.ts" \
    "$dir/herdr-setup-production-install.test.ts" \
    "$dir/herdr-setup-production-rollback.test.ts" 2>&1 | tee "$output.log" || rc=$?
  printf '%s\n' "$rc" > "$output.exit"
}

pair() {
  if (( lane % 2 == 0 )); then trial after "$1"; trial base "$1";
  else trial base "$1"; trial after "$1"; fi
}

case "$phase" in
  first) pair 1 ;;
  rest) pair 2; trial after 3; trial after 4 ;;
  after-first) trial after 1 ;;
  after-rest) trial after 2; trial after 3; trial after 4 ;;
  *) printf 'Unknown phase: %s\n' "$phase" >&2; exit 2 ;;
esac

if [[ "$phase" == rest || "$phase" == after-rest ]]; then
  for result in hsr-results/after/*.exit; do
    if [[ $(<"$result") != 0 ]]; then exit 1; fi
  done
fi
