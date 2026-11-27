#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail
raw=$1
shift
mkdir -p "$raw"
export SPIDER_TIA_DIR="$(cd "$raw" && pwd -P)"
export SPIDER_TIA_ROOT="$(pwd -P)"
export SPIDER_TIA_BUNDLE_KEYS="$(node scripts/tia/bundle-keys.mjs)"
export SPIDER_TIA=1
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=\"$SPIDER_TIA_ROOT/scripts/tia/cov-hook.cjs\""
exec env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_RUN_ID -u PI_SPIDER_DB_PATH -u PI_SPIDER_SESSION_ID \
  -u SPIDER_HERDR_E2E -u SPIDER_HERDR_APP_TESTS -u SPIDER_HERDR_APP_E2E -u XDG_RUNTIME_DIR "$@"
