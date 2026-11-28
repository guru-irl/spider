// SPDX-License-Identifier: MIT
import { closeSync, openSync, readSync } from 'node:fs';
import { basename, isAbsolute, relative, sep } from 'node:path';
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
  return Buffer.concat(chunks).toString('utf8');
}

const creation = new Set(['clone', 'clone3', 'fork', 'vfork']);
const fileOpen = new Set(['open', 'openat', 'openat2', 'creat', 'open_by_handle_at']);
const exec = new Set(['execve', 'execveat']);
const directories = new Set(['getdents', 'getdents64']);
const descriptors = new Set(['recvmsg', 'recvmmsg']);
const unsupported = new Set(['unshare', 'setns', 'chroot', 'pivot_root', 'mount', 'umount2']);

export function readKernelTrace(file, { root, tracked, owners }) {
  const tasks = new Map();
  const pending = new Map();
  const repoFiles = new Set(tracked);
  const repoDirs = new Set(['']);
  for (const path of repoFiles) {
    for (let i = path.lastIndexOf('/'); i >= 0; i = path.lastIndexOf('/', i - 1)) repoDirs.add(path.slice(0, i));
  }
  const task = pid => {
    if (!tasks.has(pid)) tasks.set(pid, { children: [], reads: new Set(), trees: new Set(), artifacts: new Set(), gaps: new Set(), nodeStarts: 0 });
    return tasks.get(pid);
  };
  function input(row, path, tree = false) {
    if (path && /^(?:pipe|socket):\[\d+\]$/.test(path)) return;
    if (!path || !isAbsolute(path)) { row.gaps.add('unresolved path'); return; }
    const name = relative(root, path);
    if (name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name)) return;
    const paths = name.endsWith(' (deleted)') ? [name, name.slice(0, -' (deleted)'.length)] : [name];
    for (const path of paths) {
      // Git can read source contents from an object rather than from its path.
      if (path.startsWith('.git/objects/')) row.gaps.add('checkout object database');
      if (tree && repoDirs.has(path)) row.trees.add(path);
      if (!tree && repoFiles.has(path)) row.reads.add(path);
      else if (!tree && path.startsWith('dist/')) row.artifacts.add(path);
    }
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
      pending.set(pid, body.slice(0, -'<unfinished ...>'.length));
      continue;
    }
    if (body.startsWith('<... ')) {
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
      // Waiting for completions does not enqueue work. Neither strace nor the
      // JS hook can identify an arbitrary operation enqueued in a native ring.
      const submitted = /^\d+(?:<.*>)?, (\d+), /.exec(args)?.[1];
      if (submitted !== '0') tracee.gaps.add('io_uring submission');
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
      input(tracee, decoded(/^<(.*)>$/.exec(result)?.[1]));
    } else if (directories.has(name)) {
      input(tracee, decoded(/^\d+<(.*)>, /.exec(args)?.[1]), true);
    } else if (exec.has(name)) {
      const executable = /^(?:[^,]*, )?"((?:[^"\\]|\\.)*)"(?=, )/.exec(args);
      const path = decoded(executable?.[1] || /^\d+<(.*)>, ""/.exec(args)?.[1]);
      input(tracee, path);
      if (path && /^(node|nodejs)(\.exe)?$/i.test(basename(path))) {
        // Unlike a guessed launch name, this is the executable named by a
        // successful kernel exec. Anything except the exact early version
        // path needs a Node recorder startup, even behind a clean shell.
        const version = process.versions.node === '26.4.0' && path === process.execPath && executable &&
          /^, \["(?:[^"\\]|\\.)*", "--version"\], /.test(args.slice(executable[0].length));
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
        exited: new Set(), gaps: new Set(), nodeStarts: new Map() });
      const test = byTest.get(name);
      if (parent && name !== parent) {
        test.gaps.add('nested test fork');
        byTest.get(parent).gaps.add('nested test fork');
      }
      for (const path of tracee.reads) test.reads.add(path);
      for (const path of tracee.trees) test.trees.add(path);
      for (const path of tracee.artifacts) test.artifacts.add(path);
      for (const gap of tracee.gaps) test.gaps.add(gap);
      if (tracee.nodeStarts) test.nodeStarts.set(pid, tracee.nodeStarts);
      if (tracee.exited) test.exited.add(pid);
      else test.gaps.add('unobserved exit');
    }
    for (const child of tracee.children) todo.push([child, name]);
  }
  if (visited !== tasks.size || !first.exited) return { error: 'unattributed trace process or missing root exit' };
  return { byTest };
}
