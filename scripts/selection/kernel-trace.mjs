// SPDX-License-Identifier: MIT
import { closeSync, openSync, readSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// The trace can be hundreds of MB. Keep only the paths in the checkout
// inventory and the process ancestry, not the syscall text or argument lists.
function* lines(file) {
  const fd = openSync(file, 'r');
  const bytes = Buffer.alloc(128 * 1024);
  const decoder = new StringDecoder('utf8');
  let rest = '';
  try {
    for (let n; (n = readSync(fd, bytes)) > 0;) {
      const rows = (rest + decoder.write(bytes.subarray(0, n))).split('\n');
      rest = rows.pop();
      yield* rows;
    }
    if (rest || decoder.end()) yield null;
  } finally { closeSync(fd); }
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decoded(text) {
  if (!text?.includes('\\')) return text;
  // strace -x uses hex byte escapes plus the usual quoted-string escapes.
  const chunks = [];
  for (const piece of text.match(/[^\\]+|\\(?:x[0-9a-f]{2}|[0-7]{1,3}|.)|\\$/gi)) {
    if (piece[0] !== '\\') chunks.push(Buffer.from(piece));
    else if (piece[1] === 'x' && piece.length === 4) chunks.push(Buffer.from([parseInt(piece.slice(2), 16)]));
    else if (/^\\[0-7]/.test(piece)) chunks.push(Buffer.from([parseInt(piece.slice(1), 8)]));
    else if (piece === '\\\\' || piece === '\\"') chunks.push(Buffer.from(piece[1]));
    else if (/^\\[abfnrtv]$/.test(piece)) chunks.push(Buffer.from([{ a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 }[piece[1]]]));
    else return null;
  }
  try { return utf8.decode(Buffer.concat(chunks)); }
  catch { return null; }
}

const fdArgument = /^(AT_FDCWD|\d+)(?:<([^>]+)>)?\s*,\s*/;
const quotedPath = /^"((?:[^"\\]|\\.)*)"(?=\s*,)/;
const procAlias = /^\/(?:proc\/(?:self|thread-self|\d+)\/(?:task\/\d+\/)?(?:fd|cwd|exe|root)|dev\/(?:fd|std(?:in|out|err)))(?:\/|$)/;
const anonymousFd = /^(?:(?:pipe|socket):\[\d+\]|anon_inode:\[[^\]]+\])$/;

function pathname(args, at) {
  const fd = at ? fdArgument.exec(args) : null;
  const rest = args.slice(fd?.[0].length ?? 0);
  const quoted = quotedPath.exec(rest);
  const operand = decoded(quoted?.[1]);
  const base = decoded(fd?.[2]);
  const absolute = operand && isAbsolute(operand);
  const anchored = base && isAbsolute(base) && !base.endsWith(' (deleted)');
  const kind = !operand ? 'pathname unavailable' : absolute ? procAlias.test(operand) ? 'proc/dev fd' : 'absolute pathname'
    : !anchored ? fd && fd[1] !== 'AT_FDCWD' ? 'unknown dirfd' : 'unknown cwd'
    : fd[1] === 'AT_FDCWD' ? 'cwd-relative' : 'dirfd-relative';
  // This is a lookup name, not a resolved target. In particular a symlink
  // followed by .. need not end up at the lexically normalized path.
  const candidate = operand && !operand.split('/').includes('..') &&
    (absolute ? operand : anchored ? join(base, operand) : null);
  return { operand, base, candidate, kind, tail: quoted ? rest.slice(quoted[0].length) : '' };
}

const creation = new Set(['clone', 'clone3', 'fork', 'vfork']);
const fileOpen = new Set(['open', 'openat', 'openat2', 'creat', 'open_by_handle_at']);
const exec = new Set(['execve', 'execveat']);
const directories = new Set(['getdents', 'getdents64']);
const descriptors = new Set(['recvmsg', 'recvmmsg']);
const unsupported = new Set(['unshare', 'setns', 'chroot', 'pivot_root', 'mount', 'umount2']);

function readRingEvents(file) {
  const events = new Map();
  let expected;
  let count = 0;
  for (const line of lines(file)) {
    if (line === null) return null;
    if (!line || line.startsWith('#')) {
      const header = /^# entries-in-buffer\/entries-written:\s*(\d+)\/(\d+)/.exec(line);
      if (header) {
        if (header[1] !== header[2] || expected !== undefined) return null;
        expected = Number(header[1]);
      }
      continue;
    }
    const event = /-(\d+)\s+\[\d+\].*:\s+io_uring_submit_req:.*\bopcode (\w+),.*\bsq_thread (0|1)\s*$/.exec(line);
    if (!event) return null;
    const [, pid, opcode, polling] = event;
    const entry = events.get(Number(pid)) ?? { count: 0, epollOnly: true };
    entry.count++;
    entry.epollOnly &&= (opcode === 'EPOLL' || opcode === 'EPOLL_CTL') && polling === '0';
    events.set(Number(pid), entry);
    count++;
  }
  return count === expected ? events : null;
}

export function readKernelTrace(file, { root, tracked, owners, ringFile }) {
  const ringEvents = ringFile && readRingEvents(ringFile);
  const tasks = new Map();
  const pending = new Map();
  const repoFiles = new Set(tracked);
  const repoDirs = new Set(['']);
  for (const path of repoFiles) {
    for (let i = path.lastIndexOf('/'); i >= 0; i = path.lastIndexOf('/', i - 1)) repoDirs.add(path.slice(0, i));
  }
  const task = pid => {
    if (!tasks.has(pid)) tasks.set(pid, { children: [], reads: new Set(), trees: new Set(), artifacts: new Set(), gaps: new Set(),
      nodeStarts: 0, ringSubmissions: 0 });
    return tasks.get(pid);
  };
  function checkoutPath(path) {
    const name = relative(root, path);
    return name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name) ? null : name;
  }
  function input(row, path, tree = false) {
    const name = checkoutPath(path);
    if (name === null) return;
    const paths = name.endsWith(' (deleted)') ? [name, name.slice(0, -' (deleted)'.length)] : [name];
    for (const path of paths) {
      // Git can read source contents from an object rather than from its path.
      if (path.startsWith('.git/objects/')) row.gaps.add('checkout object database');
      if (tree && repoDirs.has(path)) row.trees.add(path);
      if (!tree && repoFiles.has(path)) row.reads.add(path);
      else if (!tree && path.startsWith('dist/')) row.artifacts.add(path);
    }
  }
  function notePath(row, kind) {
    const counts = row.pathCounts ??= new Map();
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  function pathGap(row, kind) {
    row.gaps.add('unresolved path');
    notePath(row, `unresolved: ${kind}`);
  }
  let rootPid;
  for (const line of lines(file)) {
    const row = /^(\d+)\s+(\S.*)$/.exec(line ?? '');
    if (!row) return { error: 'unattributed or truncated trace line' };
    const pid = Number(row[1]);
    rootPid ??= pid;
    const tracee = task(pid);
    let body = row[2];
    if (tracee.exited) return { error: 'PID reused in trace' };
    if (body.startsWith('--- ')) continue;
    if (/^\+\+\+ (?:exited with \d+|killed by SIG\w+(?: \(core dumped\))?) \+\+\+$/.test(body)) {
      tracee.exited = true;
      if (pending.delete(pid)) tracee.gaps.add('unfinished syscall');
      continue;
    }
    if (body.endsWith('<unfinished ...>')) {
      if (pending.has(pid)) return { error: 'overlapping syscalls' };
      // The separator before <unfinished ...> is strace's, not a part of
      // the syscall. A resumed getdents64 continues with a comma.
      pending.set(pid, body.slice(0, -'<unfinished ...>'.length).trimEnd());
      continue;
    }
    const split = body.startsWith('<... ');
    if (split) {
      const resumed = /^<\.\.\. (\w+) resumed>(.*)$/.exec(body);
      const partial = pending.get(pid);
      if (!resumed || !partial?.startsWith(`${resumed[1]}(`)) return { error: 'unpaired syscall' };
      pending.delete(pid);
      body = partial + resumed[2];
    }
    const call = /^(\w+)\((.*)\)\s+=\s+(-?\d+|\?)(.*)$/.exec(body);
    if (!call) { tracee.gaps.add('unrecognized syscall'); continue; }
    const [, name, args, status, result] = call;
    if (name === 'io_uring_enter') {
      const requested = /^\d+(?:<.*>)?, (\d+), /.exec(args)?.[1];
      if (requested === '0') continue;
      if (requested && Number(status) > 0 && Number(status) <= Number(requested)) tracee.ringSubmissions += Number(status);
      else tracee.gaps.add('unconfirmed io_uring submission');
      continue;
    }
    if (status === '?') { tracee.gaps.add('unknown syscall result'); continue; }
    if (Number(status) < 0) continue;
    if (name === 'io_uring_setup') {
      const flags = /\{flags=([^,}]+)[,}]/.exec(args)?.[1];
      // A polling ring can enqueue operations without io_uring_enter.
      if (!flags || /IORING_SETUP_SQPOLL|0x/.test(flags)) tracee.gaps.add('io_uring polling or unknown flags');
    } else if (creation.has(name)) {
      if (Number(status) <= 0) continue;
      const child = task(Number(status));
      if (child.parent !== undefined) return { error: 'PID reused in trace' };
      child.parent = pid;
      tracee.children.push(Number(status));
    } else if (fileOpen.has(name)) {
      const { candidate, kind } = pathname(args, name === 'openat' || name === 'openat2');
      // Preserve a tracked lookup name even when it points outside the
      // checkout. Do not use a lookup name to exclude an unproven target.
      if (candidate) input(tracee, candidate);
      const target = decoded(/^<([^>]+)>$/.exec(result)?.[1]);
      if (target && isAbsolute(target)) {
        input(tracee, target);
        if (kind !== 'absolute pathname') notePath(tracee, `resolved: ${kind}`);
      } else if (target && anonymousFd.test(target)) notePath(tracee, 'resolved: anonymous fd');
      else pathGap(tracee, kind);
    } else if (directories.has(name)) {
      const target = decoded(fdArgument.exec(args)?.[2]);
      if (!target || !isAbsolute(target)) pathGap(tracee, 'getdents fd');
      else {
        input(tracee, target, true);
        if (split) notePath(tracee, checkoutPath(target) === null ? 'resumed getdents outside checkout' : 'resumed getdents in checkout');
      }
    } else if (exec.has(name)) {
      const { operand, base, candidate, kind, tail } = pathname(args, name === 'execveat');
      const fdExec = name === 'execveat' && operand === '' && /,\s*AT_EMPTY_PATH$/.test(tail);
      const path = fdExec ? base : operand;
      if (candidate) input(tracee, candidate);
      if (!path || !isAbsolute(path) || procAlias.test(path)) pathGap(tracee, `exec ${kind}`);
      else input(tracee, path);
      if (path && /^(node|nodejs)(\.exe)?$/i.test(basename(path))) {
        // Anything except the exact early version path needs a recorder
        // startup, even behind a clean shell.
        const version = process.versions.node === '26.4.0' && !fdExec && path === process.execPath &&
          /^, \["(?:[^"\\]|\\.)*", "--version"\], /.test(tail);
        if (!version) tracee.nodeStarts++;
      }
    } else if (unsupported.has(name) || (descriptors.has(name) && args.includes('SCM_RIGHTS'))) {
      tracee.gaps.add(name);
    } else if (!descriptors.has(name)) tracee.gaps.add('unrecognized syscall');
  }

  const first = tasks.get(rootPid);
  if (!first || first.parent !== undefined) return { error: 'no unique trace root' };
  const byTest = new Map();
  const todo = [[rootPid, null]];
  let visited = 0;
  while (todo.length) {
    const [pid, parent] = todo.pop();
    const name = owners.get(pid) ?? parent;
    const tracee = tasks.get(pid);
    if (++visited > tasks.size) return { error: 'cyclic trace ancestry' };
    if (name) {
      if (!byTest.has(name)) byTest.set(name, { reads: new Set(), trees: new Set(), artifacts: new Set(),
        exited: new Set(), gaps: new Set(), nodeStarts: new Map(), pathCounts: new Map() });
      const test = byTest.get(name);
      if (parent && name !== parent) {
        test.gaps.add('nested test fork');
        byTest.get(parent).gaps.add('nested test fork');
      }
      for (const path of tracee.reads) test.reads.add(path);
      for (const path of tracee.trees) test.trees.add(path);
      for (const path of tracee.artifacts) test.artifacts.add(path);
      for (const gap of tracee.gaps) test.gaps.add(gap);
      for (const [kind, count] of tracee.pathCounts ?? []) test.pathCounts.set(kind, (test.pathCounts.get(kind) ?? 0) + count);
      const ring = ringEvents?.get(pid);
      // A regular libuv loop submits EPOLL_CTL. Counting the opcodes is
      // evidence for those calls, not for other operations on the same ring.
      if ((tracee.ringSubmissions || ring) && (!ring?.epollOnly || ring.count !== tracee.ringSubmissions)) {
        test.gaps.add('io_uring submission');
      }
      if (tracee.nodeStarts) test.nodeStarts.set(pid, tracee.nodeStarts);
      if (tracee.exited) test.exited.add(pid);
      else test.gaps.add('unobserved exit');
    }
    for (const child of tracee.children) todo.push([child, name]);
  }
  if (visited !== tasks.size || !first.exited) return { error: 'unattributed trace process or missing root exit' };
  return { byTest };
}
