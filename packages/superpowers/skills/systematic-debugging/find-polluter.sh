#!/usr/bin/env bash
# Bisection script to find which test creates unwanted files/state
# Usage: ./find-polluter.sh <file_or_dir_to_check> <test_pattern>
# Example: ./find-polluter.sh '.git' 'src/**/*.test.ts'

set -e

if [ $# -ne 2 ]; then
  echo "Usage: $0 <file_to_check> <test_pattern>"
  echo "Example: $0 '.git' 'src/**/*.test.ts'"
  exit 64
fi

POLLUTION_CHECK="$1"
TEST_PATTERN="$2"

echo "🔍 Searching for test that creates: $POLLUTION_CHECK"
echo "Test pattern: $TEST_PATTERN"
echo ""

# Get list of test files (find . emits ./-prefixed paths, so accept the
# pattern written with or without a leading ./)
TEST_PATTERN="${TEST_PATTERN#./}"
# find -path can't match '**/' against zero directory levels, so a pattern
# like src/**/*.test.ts would skip src/top.test.ts; also try the pattern
# with '**/' collapsed to cover files directly under the base directory.
TEST_FILES=$(find . \( -path "./$TEST_PATTERN" -o -path "./${TEST_PATTERN//\*\*\//}" \) | sort -u)
if [ -z "$TEST_FILES" ]; then
  TOTAL=0
else
  TOTAL=$(printf '%s\n' "$TEST_FILES" | wc -l | tr -d ' ')
fi

echo "Found $TOTAL test files"
echo ""

if [ "$TOTAL" -eq 0 ]; then
  echo "Inconclusive: no tests matched: $TEST_PATTERN"
  exit 2
fi

# npm exits 1 for a missing test script too, which is not a test failure.
if [ ! -f package.json ] || ! node -e '
  const fs = require("fs");
  try {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const test = pkg && pkg.scripts && pkg.scripts.test;
    process.exit(typeof test === "string" && test.trim() ? 0 : 1);
  } catch { process.exit(1); }
' > /dev/null 2>&1; then
  echo "Inconclusive: no npm test script"
  exit 2
fi

COUNT=0
RAN=0
for TEST_FILE in $TEST_FILES; do
  COUNT=$((COUNT + 1))

  # Skip if pollution already exists
  if [ -e "$POLLUTION_CHECK" ]; then
    echo "⚠️  Pollution already exists before test $COUNT/$TOTAL"
    echo "   Skipping: $TEST_FILE"
    continue
  fi

  echo "[$COUNT/$TOTAL] Testing: $TEST_FILE"

  # Test failures can still reveal pollution; command-start failures cannot.
  # Disable errexit in the child so Bash 3.2 preserves startup exit codes.
  TEST_STATUS=0
  TEST_OUTPUT=$(set +e; npm test "$TEST_FILE" 2>&1) || TEST_STATUS=$?
  case "$TEST_STATUS" in
    126|127)
      echo "Inconclusive: test command could not run: npm test $TEST_FILE"
      exit 2
      ;;
  esac
  case "$TEST_OUTPUT" in
    *"Missing script"*)
      echo "Inconclusive: no npm test script"
      exit 2
      ;;
  esac
  RAN=$((RAN + 1))

  # Check if pollution appeared
  if [ -e "$POLLUTION_CHECK" ]; then
    echo ""
    echo "Found polluter: $TEST_FILE"
    echo "   Test: $TEST_FILE"
    echo "   Created: $POLLUTION_CHECK"
    echo ""
    echo "Pollution details:"
    ls -la "$POLLUTION_CHECK"
    echo ""
    echo "To investigate:"
    echo "  npm test $TEST_FILE    # Run just this test"
    echo "  cat $TEST_FILE         # Review test code"
    exit 1
  fi
done

echo ""
if [ "$RAN" -eq 0 ]; then
  echo "Inconclusive: no tests ran (pollution already exists)"
  exit 2
fi
echo "No polluter found - all tests clean!"
exit 0
