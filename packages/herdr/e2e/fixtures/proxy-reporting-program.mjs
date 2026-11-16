// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// All input in this fixture goes to its own reporting target, never an agent.
export const resetModes = '\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[<u\x1b[?25h\x1b[0m';
export const ttyProof = String.raw`
import errno, json, os, pty, select, shutil, subprocess, sys, termios, time, tty
c = json.loads(sys.argv[1])
binary, root = c['binary'], c['root']
local, remote = c['local']['env'], c['remote']['env']
reset = bytes.fromhex(c['resetHex'])
log = os.path.join(root, 'proxy-target-input.jsonl')
children = []
def call(args, env=local, check=True):
    p = subprocess.run([binary] + args, env=env, capture_output=True, text=True, timeout=15)
    if check and p.returncode: raise RuntimeError(str((args, p.returncode, p.stdout, p.stderr)))
    try: value = json.loads(p.stdout)
    except ValueError: value = None
    return dict(code=p.returncode, stdout=p.stdout, stderr=p.stderr, value=value)
def wait_for(fn, label):
    end = time.monotonic() + 5
    while time.monotonic() < end:
        value = fn()
        if value: return value
        select.select([], [], [], .01)
    raise RuntimeError('timeout: ' + label)
def log_text():
    try:
        with open(log) as f: return f.read()
    except FileNotFoundError: return ''
def collect(fd, data, until=None):
    if select.select([fd], [], [], .02)[0]:
        try: data.extend(os.read(fd, 65536))
        except OSError as e:
            if e.errno != errno.EIO: raise
    return until is None or until in data

def attach(address, observe=False):
    m, s = pty.openpty()
    tty.setraw(s)
    args = [binary, 'attach', '--history', '100'] + (['--observe'] if observe else []) + [address]
    p = subprocess.Popen(args, env=local, stdin=s, stdout=s, stderr=s, start_new_session=True)
    os.close(s); children.append((p, m))
    data = bytearray()
    wait_for(lambda: collect(m, data, b'PROXY-CANARY'), 'attached target screen')
    return p, m, data

def finish(p, m, data):
    wait_for(lambda: (collect(m, data), p.poll() is not None)[1], 'attach exit')
    collect(m, data)
    return dict(exitCode=p.returncode, output=bytes(data).decode('utf8', 'replace'))

if c.get('stopProof'):
    ends = {}
    for side, env in [('remote', remote), ('local', local)]:
        record = c[side]
        state = call(['server', 'status', '--json'], env)['value']
        if state.get('pid') != record['pid'] or state.get('core', {}).get('id') != record['coreId']:
            raise RuntimeError('refusing to stop a changed core')
        result = call(['run', '--bg', '--no-notify', '--outlive-parent', '--keep', '--json', '--cwd', root,
            '--', c['node'], c['program'], '--target', log], env)['value']
        addr = result.get('address') or result['terminal']['address']
        p, m, data = attach(record['coreId'] + '/' + addr.split('/')[-1])
        call(['server', 'stop', '--json'], env)
        ends[side + 'CoreStop'] = finish(p, m, data)
        os.close(m)
    print(json.dumps(ends)); sys.exit(0)

receipt = {}
target = None
proxy = None
decoy = None
try:
    version = call(['--version'])['stdout'].strip().split()[-1]
    result = call(['run', '--bg', '--no-notify', '--outlive-parent', '--keep', '--json', '--cwd', root,
        '--', c['node'], c['program'], '--target', log], remote)['value']
    target = result.get('address') or result['terminal']['address']
    tid = target.split('/')[-1]
    address = c['remote']['coreId'] + '/' + tid
    wait_for(lambda: 'ready' in log_text(), 'reporting target ready')
    exact = call(['get', address, '--json'])['value']
    receipt['qualifiedGet'] = exact
    # Renaming the routing alias must not change core-ID addressing.
    call(['machine', 'rename', c['machine'], 'box-1.invalid', '--json'])
    decoy_env = dict(local, HC_SESSION='e')
    call(['server', 'start', '--json'], decoy_env)
    decoy = call(['server', 'status', '--json'], decoy_env)['value']
    with open(os.path.join(root, 'proxy-decoy-core.json'), 'w') as f: json.dump(decoy, f)
    core_copy = os.path.join(root, 'herdr-core')
    shutil.copy2(binary, core_copy)
    via = os.path.join(root, 'via-decoy')
    env_file = os.path.join(root, 'decoy-env.json')
    with open(env_file, 'w') as f: json.dump(decoy_env, f)
    os.chmod(env_file, 0o600)
    with open(via, 'w') as f:
        f.write('#!/usr/bin/python3\nimport json,os\nenv=json.load(open(' + repr(env_file) + '))\nos.execve(' + repr(core_copy) + ', [\"herdr-core\", \"connect\", \"--session\", \"e\"], env)\n')
    os.chmod(via, 0o700)
    call(['machine', 'add', '--via', via, '--name', c['machine'], '--session', 'e', '--json'])
    machines = call(['machine', 'ls', '--json'])['value']['machines']
    reused = next(row for row in machines if row['name'] == c['machine'])
    p, m, data = attach(address)
    receipt['coreIdAddressing'] = b'PROXY-CANARY' in data
    receipt['reusedAlias'] = reused['id'] != c['remote']['coreId'] and receipt['coreIdAddressing']
    receipt['aliasReuse'] = dict(oldCore=c['remote']['coreId'], successorCore=reused['id'])
    im, ins = pty.openpty(); tty.setraw(ins)
    # Closed input gate drains a real raw TTY; no bytes enter attach.
    os.write(im, b'DISCARD-WHILE-CLOSED\r')
    discarded = os.read(ins, 4096)
    os.write(im, b'QUEUED-BEFORE-ATTACH\r')
    termios.tcflush(ins, termios.TCIFLUSH)
    flushed = not select.select([ins], [], [], .05)[0]
    output = bytearray()
    outm, outs = pty.openpty(); tty.setraw(outs)
    def reset_before(event):
        os.write(outm, reset + event.encode())
        output.extend(os.read(outs, 4096))
    reset_before('attach')
    # Core identity and incarnation are verified before releasing input.
    verified_facts = call(['get', address, '--json'])['value']
    fields = ['created_ms', 'pid', 'labels', 'argv']
    verified = all(verified_facts.get(k) == exact.get(k) for k in fields) and verified_facts.get('state') == 'live'
    if not verified: raise RuntimeError('target incarnation changed before input release: ' + json.dumps(dict(before=exact, after=verified_facts)))
    os.write(im, b'VERIFIED-INPUT\r')
    os.write(m, os.read(ins, 4096))
    wait_for(lambda: '56455249464945442d494e505554' in log_text(), 'verified target input')
    reset_before('status'); reset_before('retarget'); reset_before('exit')
    proxy_result = call(['run', '--bg', '--no-notify', '--outlive-parent', '--keep', '--json', '--cwd', root,
        '--', binary, 'attach', '--history', '100', address])['value']
    proxy = proxy_result.get('address') or proxy_result['terminal']['address']
    native_states = []
    for state in ['working', 'blocked', 'error', 'done']:
        os.write(m, state.encode() + b'\r')
        last_facts = [None]
        def reported():
            v = call(['get', address, '--json'])['value']; last_facts[0] = v
            status = v.get('status')
            return v if isinstance(status, dict) and status.get('state') == state and status.get('app') == 'pi' else None
        try: facts = wait_for(reported, 'source status ' + state)
        except RuntimeError: raise RuntimeError('status shape: ' + json.dumps(last_facts[0]) + ' input: ' + log_text())
        native_states.append(dict(state=state, target=facts, proxy=call(['get', proxy, '--json'])['value']))
    receipt['nativeCoreFacts'] = native_states
    text = log_text()
    receipt['tty'] = dict(gated='44495343415244' not in text, rawDiscard=discarded == b'DISCARD-WHILE-CLOSED\r',
        flush=flushed and '515545554544' not in text,
        resetBeforeAttach=reset + b'attach' in output, resetBeforeStatus=reset + b'status' in output,
        resetBeforeRetarget=reset + b'retarget' in output, resetOnExit=output.endswith(reset+b'exit'),
        implementation='stdlib-pty-raw-gate-and-tcflush', resetHex=reset.hex())
    os.close(im); os.close(ins); os.close(outm); os.close(outs)
    os.write(m, b'\x1c')
    detach = finish(p, m, data)
    # Measure observe's refusal to type. Its stream has no input authority.
    op, om, od = attach(address, True)
    before = log_text(); os.write(om, b'OBSERVE-MUST-NOT-TYPE\r')
    collect(om, od)
    receipt['observeDoesNotType'] = log_text() == before
    op.terminate(); observer = finish(op, om, od)
    # A severed attach PTY is not a proved user detach.
    lp, lm, ld = attach(address)
    os.close(lm)
    wait_for(lambda: lp.poll() is not None, 'link-loss attach exit')
    receipt['detach'] = dict(classifier='stream-loss', ctrlBackslash=detach, linkLoss=dict(exitCode=lp.returncode), observeExit=observer,
        reason='No unique authenticated user-detach marker is emitted; all stream ends reconnect')
    receipt['minimumHcVersion'] = version
    receipt['resetProofOutputHex'] = output.hex()
    receipt['targetInput'] = [json.loads(line) for line in log_text().splitlines()]
    receipt['targetFacts'] = call(['get', address, '--json'])['value']
    print(json.dumps(receipt))
finally:
    for child, fd in children:
        if child.poll() is None:
            child.terminate()
            try: child.wait(timeout=2)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
        try: os.close(fd)
        except OSError: pass
    if proxy:
        call(['kill', proxy, '--json'], local, False)
        call(['rm', proxy, '--json'], local, False)
    if target:
        call(['kill', target, '--json'], remote, False)
        call(['rm', target, '--json'], remote, False)
    if decoy:
        call(['machine', 'rm', c['machine'], '--json'], local, False)
        status = call(['server', 'status', '--json'], decoy_env, False)['value']
        if status and status.get('core') == decoy.get('core') and status.get('pid') == decoy.get('pid'):
            call(['server', 'stop', '--json'], decoy_env, False)
`;

async function main() {
  if (process.argv[2] === '--prove') {
    const config = JSON.parse(process.argv[3]);
    const child = spawn('/usr/bin/python3', ['-c', ttyProof, JSON.stringify({ ...config, node: process.execPath,
      program: fileURLToPath(import.meta.url), resetHex: Buffer.from(resetModes).toString('hex') })], { stdio: 'inherit' });
    child.on('exit', code => { process.exitCode = code ?? 1; });
    return;
  }
  if (process.argv[2] !== '--target') throw new Error('Expected --prove or --target');
  const file = process.argv[3];
  writeFileSync(file, JSON.stringify({ ready: true, pid: process.pid, terminal: process.env.HC_TERMINAL_ID }) + '\n', { mode: 0o600 });
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  let state = 'working';
  const report = () => process.stdout.write(`\x1b]0;Synthetic proxy target\x07\x1b]7501;state=${state}:app=pi\x1b\\\nPROXY-CANARY ${state}\n`);
  report();
  process.stdin.on('data', data => {
    appendFileSync(file, JSON.stringify({ inputHex: data.toString('hex') }) + '\n');
    const requested = data.toString().trim();
    if (['working', 'blocked', 'error', 'done'].includes(requested)) state = requested;
    report();
  });
  setInterval(() => {}, 1000);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
