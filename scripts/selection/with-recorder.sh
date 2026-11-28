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
  trace=(strace -f -q -x -y -s 256 --seccomp-bpf -e "trace=$calls" -o "${SPIDER_SELECTION_DIR}.linux-trace" -- "${run[@]}")
  : > "${SPIDER_SELECTION_DIR}.io-uring"

  # Strace cannot see operations submitted through a mapped io_uring queue.
  # The private tracefs instance supplies those opcodes on Linux CI. Missing
  # permissions, unknown opcodes, and dropped events keep the fallback.
  instance="/sys/kernel/tracing/instances/spider-selection-$$-$RANDOM"
  ring=0
  trace_setting() { printf '%s\n' "$1" | sudo -n tee "$instance/$2" >/dev/null; }
  if sudo -n mkdir "$instance" 2>/dev/null; then
    trap 'sudo -n rmdir "$instance" || true' EXIT
    # IORING_OP_EPOLL_CTL is 29. An omitted opcode leaves fewer events
    # than strace's submission count, so it cannot make a record complete.
    if trace_setting 0 tracing_on && trace_setting 8192 buffer_size_kb &&
      trace_setting 'opcode == 29 && sq_thread == 0' events/io_uring/io_uring_submit_req/filter &&
      trace_setting 1 events/io_uring/io_uring_submit_req/enable && trace_setting 1 tracing_on; then
      ring=1
    fi
  fi
  code=0
  "${trace[@]}" || code=$?
  if ((ring)) && trace_setting 0 tracing_on &&
    sudo -n find "$instance/per_cpu" -name stats -exec awk '
      /^[[:space:]]*(overrun|commit overrun|dropped events):/ { seen++; if ($NF != 0) lost=1 }
      END { exit !(seen > 0 && !lost) }
    ' {} + && sudo -n cat "$instance/trace" > "${SPIDER_SELECTION_DIR}.io-uring.tmp"; then
    mv "${SPIDER_SELECTION_DIR}.io-uring.tmp" "${SPIDER_SELECTION_DIR}.io-uring" || true
  fi
  exit "$code"
fi
exec "${run[@]}"
