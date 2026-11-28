#!/usr/bin/env bash
set -euo pipefail

lane=$1
phase=$2
dir=packages/host/src/__tests__
files=(herdr-setup-fixture.ts herdr-setup-releases.test.ts herdr-setup-cross-machine.test.ts)
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
    "$dir/herdr-setup-production-rollback.test.ts" \
    "$dir/herdr-setup-cross-machine.test.ts" 2>&1 | tee "$output.log" || rc=$?
  printf '%s\n' "$rc" > "$output.exit"
  if (( rc != 0 )); then return "$rc"; fi
  node - "$output.json" <<'NODE'
const fs = require('node:fs');
const result = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const target = result.testResults.find(suite => suite.name.endsWith('/herdr-setup-releases.test.ts'));
if (!target || target.assertionResults.length !== 31) throw new Error('Expected all 31 release cases');
const cross = result.testResults.find(suite => suite.name.endsWith('/herdr-setup-cross-machine.test.ts'));
if (!cross) throw new Error('Missing cross-machine suite');
const crossNames = ['0.1.13', '0.1.16'].map(version => `${version} rollback removes created mod directories but preserves existing and populated directories`);
const crossCases = crossNames.map(name => {
  const test = cross.assertionResults.find(item => item.fullName === name);
  if (!test) throw new Error(`Missing changed cross-machine case: ${name}`);
  return test;
});
for (const [suite, tests] of [[target, target.assertionResults], [cross, crossCases]]) {
  for (const test of tests) {
    if (test.status !== 'passed' || !Number.isFinite(test.duration)) throw new Error(`Missing passing duration: ${test.fullName}`);
    if (test.duration >= 15000) {
      console.error(`STOP: ${suite.name}: ${test.fullName}: ${test.duration} ms`);
      process.exitCode = 1;
    }
  }
}
for (const suite of result.testResults) {
  const timed = suite.assertionResults.filter(test => Number.isFinite(test.duration));
  if (!timed.length) throw new Error(`Missing timed cases: ${suite.name}`);
  const slowest = timed.reduce((a, b) => a.duration >= b.duration ? a : b);
  console.log(`SLOWEST: ${suite.name}: ${slowest.fullName}: ${slowest.duration} ms`);
}
NODE
}

pair() {
  if (( lane % 2 == 0 )); then trial after "$1"; trial base "$1";
  else trial base "$1"; trial after "$1"; fi
}

case "$phase" in
  first) pair 1 ;;
  rest) pair 2; trial after 3; trial after 4 ;;
  after-first) trial after 1 ;;
  after-rest) trial after 2 ;;
  *) printf 'Unknown phase: %s\n' "$phase" >&2; exit 2 ;;
esac

if [[ "$phase" == rest || "$phase" == after-rest ]]; then
  for result in hsr-results/after/*.exit; do
    if [[ $(<"$result") != 0 ]]; then exit 1; fi
  done
fi
