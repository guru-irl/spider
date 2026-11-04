import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const release = 'npm:@guru-irl/spider@https://github.com/guru-irl/spider/releases/download/v0.1.0/guru-irl-spider-0.1.0.tgz';

function anchors(text: string): Set<string> {
  const headings = [...text.matchAll(/^#{1,6}\s+(.+)$|<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gm)];
  const ids = new Set([...text.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]!));
  for (const match of headings) {
    const title = (match[1] ?? match[2]!).replace(/<[^>]*>/g, '').trim();
    const base = title.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-');
    let id = base;
    for (let count = 1; ids.has(id); count++) id = `${base}-${count}`;
    ids.add(id);
  }
  return ids;
}

describe('README contracts', () => {
  it('leads with a named release tarball and gives matching update and remove commands', () => {
    expect(readme).toContain(`pi install ${release}`);
    expect(readme.indexOf(`pi install ${release}`)).toBeLessThan(readme.indexOf('git clone'));
    expect(readme).toContain(`pi update ${release}`);
    expect(readme).toContain(`pi remove ${release}`);
  });

  it('puts a theme-aware decorative web mark beside the title', () => {
    const title = readme.match(/<h1>[\s\S]*?<\/h1>/)?.[0];
    expect(title).toBeDefined();
    expect(title).toMatch(/<picture>[\s\S]*<source\b[^>]*media="\(prefers-color-scheme: dark\)"[^>]*srcset="docs\/assets\/spider-mark-dark.svg"/);
    expect(title).toMatch(/<img\b[^>]*src="docs\/assets\/spider-mark-light.svg"[^>]*alt=""[^>]*width="32"[^>]*height="32"[^>]*style="vertical-align: middle;?"/);
    expect(title).toMatch(/<\/picture>\s*spider\s*<\/h1>/);
  });

  it('uses fixed theme colors without changing the source web paths', () => {
    const original = readFileSync(join(root, 'packages/herdr/assets/tabs/spider.svg'), 'utf8');
    for (const [theme, color] of [['dark', '#e6edf3'], ['light', '#1f2328']]) {
      const file = join(root, `docs/assets/spider-mark-${theme}.svg`);
      expect(existsSync(file), file).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe(original.replace('stroke="currentColor"', `stroke="${color}"`));
    }
  });

  it('resolves every relative README link and anchor', () => {
    const links = [...readme.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)|\b(?:src|srcset)="([^"]+)"/g)];
    expect(links.length).toBeGreaterThan(20);
    for (const match of links) {
      const target = match[1] ?? match[2]!;
      if (/^(?:[a-z]+:|\/\/)/i.test(target)) continue;
      const [path, fragment] = target.split('#');
      const file = path ? join(root, decodeURIComponent(path)) : join(root, 'README.md');
      expect(existsSync(file), target).toBe(true);
      if (fragment) expect(anchors(readFileSync(file, 'utf8')).has(decodeURIComponent(fragment)), target).toBe(true);
    }
  });

  it('keeps the README-only web marks out of the npm package', () => {
    expect(existsSync(join(root, 'docs/assets/spider-mark-dark.svg'))).toBe(true);
    expect(existsSync(join(root, 'docs/assets/spider-mark-light.svg'))).toBe(true);
    const directory = join(root, '.spider/scratch/readme-pack');
    mkdirSync(directory, { recursive: true });
    const pack = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', env: { ...process.env, npm_config_cache: directory }, timeout: 60_000 });
    const files = JSON.parse(pack)[0].files.map((file: { path: string }) => file.path) as string[];
    expect(files).toContain('README.md');
    expect(files).not.toContain('docs/assets/spider-mark-dark.svg');
    expect(files).not.toContain('docs/assets/spider-mark-light.svg');
  });
});
