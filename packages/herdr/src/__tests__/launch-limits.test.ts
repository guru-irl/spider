import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { exactLaunchArgv } from '../sessions/launch-limits';

it('the exact command pins Pi inside the child, not only the hc client environment', () => {
  // printf stands in for the executable; the shell expands the exported value.
  const argv = exactLaunchArgv('/bin/sh', '/bin/sh', '/fixture/session.jsonl', { soft: 1024, hard: 65536 },
    { globalRoot: '/fixture/global', agentDirectory: '/fixture/agent', handoffFile: '/fixture/handoff.json' });
  const tail = argv.slice(0, -3);
  tail.push('/bin/sh', '-c', 'printf "%s\\n" "$SPIDER_ROAM_PI" "$SPIDER_GLOBAL_ROOT" "$PI_CODING_AGENT_DIR" "$SPIDER_HERDR_HANDOFF_FILE"');
  const result = spawnSync(tail[0], tail.slice(1), { env: { PATH: '/usr/bin:/bin', SPIDER_ROAM_PI: '/wrong/pi' }, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim().split('\n')).toEqual(['/bin/sh', '/fixture/global', '/fixture/agent', '/fixture/handoff.json']);
});
