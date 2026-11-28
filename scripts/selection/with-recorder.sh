#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail
raw=$1
shift
mkdir -p "$raw"
export SPIDER_SELECTION_DIR="$(cd "$raw" && pwd -P)"
export SPIDER_SELECTION_ROOT="$(pwd -P)"
SPIDER_SELECTION_BUNDLE_KEYS="$(node scripts/selection/bundle-keys.mjs)"
export SPIDER_SELECTION_BUNDLE_KEYS
export SPIDER_SELECTION=1
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=\"$SPIDER_SELECTION_ROOT/scripts/selection/cov-hook.cjs\""
run=(env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_RUN_ID -u PI_SPIDER_DB_PATH -u PI_SPIDER_SESSION_ID
  -u SPIDER_HERDR_E2E -u SPIDER_HERDR_APP_TESTS -u SPIDER_HERDR_APP_E2E -u XDG_RUNTIME_DIR
  -u SPIDER_SELECTION_KERNEL_TRACE "$@")
if [[ ${SPIDER_SELECTION_KERNEL_TRACE:-} == 1 ]]; then
  # Follow children and threads, including native commands and shells that
  # clear their environment. Keep the raw trace out of the uploaded raw dir.
  calls=clone,clone3,fork,vfork,execve,execveat,open,openat,openat2,creat,open_by_handle_at,getdents,getdents64
  calls+=,recvmsg,recvmmsg,io_uring_setup,io_uring_enter,unshare,setns,chroot,pivot_root,mount,umount2
  printf '%s\n' linux-strace-v2 > "$SPIDER_SELECTION_DIR/kernel-mode"
  exec strace -f -q -x -y --seccomp-bpf -e "trace=$calls" -o "${SPIDER_SELECTION_DIR}.linux-trace" -- "${run[@]}"
fi
exec "${run[@]}"
