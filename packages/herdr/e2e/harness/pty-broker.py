#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Gurupungav Narayanan
"""PTY broker for interactive pi inside an hc terminal.

Runs the given command on an inner PTY of fixed size, relays every output byte to the outer terminal (so hc sees
OSC status sequences) and to a raw log. Input comes only from the broker's own Unix socket, and only when the request
names the inner PID and the broker's hc terminal id. The outer terminal's input is drained and ignored.

usage: pty-broker.py --socket PATH --log PATH [--env-file JSON] [--cols 120] [--rows 40] -- COMMAND [ARGS...]
--env-file replaces the inherited environment with the file's object, keeping only HC_* variables from hc.
Socket protocol (one JSON object per line, one reply per line):
  {"op":"hello"}                                  -> {"pid":N,"terminal":ID}
  {"op":"input","pid":N,"terminal":ID,"data":S}   -> {"ok":true}
  {"op":"resize","pid":N,"terminal":ID,"cols":C,"rows":R} -> {"ok":true}
"""
import fcntl, json, os, pty, select, signal, socket, struct, sys, termios

def main():
    args = sys.argv[1:]
    if '--' not in args:
        sys.stderr.write('pty-broker: missing -- COMMAND\n'); return 96
    split = args.index('--'); options, command = args[:split], args[split + 1:]
    opts = dict(zip(options[0::2], options[1::2]))
    sock_path, log_path = opts.get('--socket'), opts.get('--log')
    cols, rows = int(opts.get('--cols', '120')), int(opts.get('--rows', '40'))
    if not sock_path or not log_path or not command:
        sys.stderr.write('pty-broker: --socket, --log and COMMAND are required\n'); return 96
    terminal = os.environ.get('HC_TERMINAL_ID', '')
    child_env = dict(os.environ)
    if opts.get('--env-file'):
        with open(opts['--env-file']) as handle: fenced = json.load(handle)
        if not isinstance(fenced, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in fenced.items()):
            sys.stderr.write('pty-broker: --env-file must hold a string map\n'); return 96
        child_env = {**fenced, **{k: v for k, v in os.environ.items() if k.startswith('HC_')}}
    pid, master = pty.fork()
    if pid == 0:
        os.execvpe(command[0], command, child_env)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    os.kill(pid, signal.SIGWINCH)
    try: os.unlink(sock_path)
    except FileNotFoundError: pass
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); server.bind(sock_path); os.chmod(sock_path, 0o600); server.listen(8)
    log = open(log_path, 'ab', buffering=0)
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, lambda s, f: os.kill(pid, s))
    clients, buffers = [], {}
    outer_in = sys.stdin.fileno() if not sys.stdin.closed else None
    def reply(conn, value):
        try: conn.sendall((json.dumps(value) + '\n').encode())
        except OSError: pass
    def handle(conn, line):
        try: request = json.loads(line)
        except ValueError: return reply(conn, {'error': 'malformed'})
        op = request.get('op')
        if op == 'hello': return reply(conn, {'pid': pid, 'brokerPid': os.getpid(), 'terminal': terminal})
        if request.get('pid') != pid or request.get('terminal') != terminal:
            return reply(conn, {'error': 'identity-mismatch'})
        if op == 'input' and isinstance(request.get('data'), str):
            os.write(master, request['data'].encode('utf-8')); return reply(conn, {'ok': True})
        if op == 'resize':
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', int(request['rows']), int(request['cols']), 0, 0)); os.kill(pid, signal.SIGWINCH)
            return reply(conn, {'ok': True})
        return reply(conn, {'error': 'unsupported'})
    status = None
    while status is None:
        watched = [master, server] + clients + ([outer_in] if outer_in is not None else [])
        try: ready, _, _ = select.select(watched, [], [], 0.5)
        except InterruptedError: ready = []
        for fd in ready:
            if fd == master:
                try: data = os.read(master, 65536)
                except OSError: data = b''
                if not data:
                    _, raw = os.waitpid(pid, 0); status = os.waitstatus_to_exitcode(raw); break
                log.write(data)
                try: os.write(1, data)
                except OSError: pass
            elif fd == server:
                conn, _ = server.accept(); clients.append(conn); buffers[conn] = b''
            elif fd == outer_in:
                try:
                    if not os.read(outer_in, 65536): outer_in = None
                except OSError: outer_in = None
            else:
                chunk = fd.recv(65536)
                if not chunk:
                    clients.remove(fd); buffers.pop(fd, None); fd.close(); continue
                buffers[fd] += chunk
                while b'\n' in buffers[fd]:
                    line, buffers[fd] = buffers[fd].split(b'\n', 1); handle(fd, line.decode('utf-8', 'replace'))
        if status is None:
            done, raw = os.waitpid(pid, os.WNOHANG)
            if done:
                # Drain remaining output before exiting.
                try:
                    while True:
                        data = os.read(master, 65536)
                        if not data: break
                        log.write(data); os.write(1, data)
                except OSError: pass
                status = os.waitstatus_to_exitcode(raw)
    try: os.unlink(sock_path)
    except FileNotFoundError: pass
    return status if status >= 0 else 128 - status

if __name__ == '__main__':
    sys.exit(main())
