import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Mode = "normal" | "group" | "holder" | "delayed" | "startup-stall" | "command-stall" | "fulfill-error" | "navigate-error" | "load-stall" | "close-stall" | "stderr-holder" | "unrelated-group";
export function createPipeBrowser(dir: string, mode: Mode = "normal"): { executable: string; launchFile: string; pidFile: string; descendantFile: string; eofFile: string; close(): void } {
  const executable = join(dir, "pipe-browser.mjs");
  const launchFile = join(dir, "launch.json");
  const pidFile = join(dir, "pid");
  const descendantFile = join(dir, "descendant");
  const eofFile = join(dir, "pipe-eof");
  const holderCode = `const { createReadStream, writeFileSync } = require('node:fs'); process.on('message', () => { createReadStream('', { fd: 3 }).on('data', () => {}).on('end', () => writeFileSync(${JSON.stringify(eofFile)}, 'closed')); }); setInterval(() => {}, 1000);`;
  writeFileSync(executable, `#!${process.execPath}
import { createReadStream, writeSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
writeFileSync(${JSON.stringify(launchFile)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME, env: process.env }));
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const mode = ${JSON.stringify(mode)};
let child;
if (mode === 'unrelated-group') {
  child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ${JSON.stringify(dir)}, 'unrelated-helper'], { stdio: 'ignore' });
  writeFileSync(${JSON.stringify(descendantFile)}, String(child.pid));
}
if (mode === 'group' || mode === 'holder' || mode === 'stderr-holder') {
  child = spawn(process.execPath, ['-e', mode === 'holder' ? ${JSON.stringify(holderCode)} : 'setInterval(() => {}, 1000)', ${JSON.stringify(dir)}, ...process.argv.slice(2)], { detached: mode === 'holder' || mode === 'stderr-holder', stdio: mode === 'stderr-holder' ? ['ignore', 'ignore', 2] : ['ignore', 'ignore', 'ignore', 3, 4, 'ipc'] });
  writeFileSync(${JSON.stringify(descendantFile)}, String(child.pid));
}
let buffer = '';
let blocked;
const waiting = [];
function reply(message, result) { writeSync(4, JSON.stringify({ id: message.id, result }) + '\\0'); }
function event(method, params = {}, sessionId = 'session') { writeSync(4, JSON.stringify({ method, sessionId, params }) + '\\0'); }
function diagnostic() { writeSync(2, 'DISCARDED-PREFIX' + 'x'.repeat(9000) + '\\u001b[31mfixture stderr tail\\n'); }
createReadStream('', { fd: 3 }).on('data', chunk => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\\0')) !== -1) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    const method = message.method;
    if (method === 'Browser.close') { if (mode === 'close-stall') continue; if (mode === 'holder') child.send('read', () => process.exit(0)); else process.exit(0); return; }
    if (method === 'Browser.getVersion' && mode === 'delayed') { setTimeout(() => reply(message, {}), 350); continue; }
    if (method === 'Browser.getVersion' && mode === 'startup-stall') { diagnostic(); continue; }
    if (method === 'Runtime.evaluate' && mode === 'command-stall') { diagnostic(); continue; }
    if (method === 'Fetch.enable') {
      reply(message, {});
      event('Fetch.requestPaused', { requestId: 'canary', request: { url: 'http://127.0.0.1:1234/api/overview' } });
      event('Fetch.requestPaused', { requestId: 'foreign-session', request: { url: 'https://dashboard.invalid/api/overview' } }, 'other-session');
    } else if (method === 'Fetch.failRequest' || method === 'Fetch.continueRequest' || method === 'Fetch.fulfillRequest') {
      if (message.params.requestId === 'foreign-session') { blocked = false; reply(message, {}); continue; }
      if (method === 'Fetch.fulfillRequest' && mode === 'fulfill-error') { writeSync(4, JSON.stringify({ id: message.id, error: { code: -32000, message: 'fixture fulfil failure' } }) + '\\0'); continue; }
      if (message.params.requestId === 'canary') blocked = method === 'Fetch.failRequest'; reply(message, {});
      for (const pending of waiting) reply(pending, { result: { value: blocked } });
    } else if (method === 'Page.navigate') {
      if (mode === 'navigate-error') reply(message, { errorText: 'fixture navigation failure' });
      else {
        reply(message, {});
        event('Fetch.requestPaused', { requestId: 'document', request: { url: message.params.url } });
        if (mode !== 'load-stall') setTimeout(() => event('Page.loadEventFired'), 20);
      }
    } else if (method === 'Runtime.evaluate') {
      if (message.params.expression === 'blocked') {
        if (blocked === undefined) waiting.push(message); else reply(message, { result: { value: blocked } });
      } else if (message.params.expression === 'throw') {
        reply(message, { exceptionDetails: { exception: { description: '\\u001b[31mfixture exception\\n' + 'x'.repeat(1000) } } });
      } else reply(message, { result: { value: true } });
    } else if (method === 'Target.createTarget') reply(message, { targetId: 'target' });
    else if (method === 'Target.attachToTarget') reply(message, { sessionId: 'session' });
    else if (method === 'Page.getFrameTree') reply(message, { frameTree: { frame: { id: 'frame' } } });
    else if (method === 'Page.captureScreenshot') reply(message, { data: 'cG5n' });
    else reply(message, {});
  }
});
`, { mode: 0o700 });
  return { executable, launchFile, pidFile, descendantFile, eofFile, close() {
    for (const file of [pidFile, descendantFile]) {
      try { const pid = Number(readFileSync(file, "utf8")); try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); } } catch { /* fixture already closed */ }
    }
  } };
}
