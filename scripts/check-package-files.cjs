// Verify npm's file list; assert-bundle.mjs separately verifies the tarball bytes.
const fs = require('node:fs');
let input = '';
process.stdin.on('data', chunk => { input += chunk; }).on('end', () => {
  const [pack] = JSON.parse(input);
  const files = pack.files.map(file => file.path);
  const skillDirs = ['packages/superpowers/skills', 'packages/pstack/skills'];
  const skills = skillDirs.flatMap(dir => fs.readdirSync(dir, { recursive: true })
    .filter(file => file === 'SKILL.md' || file.endsWith('/SKILL.md')).map(file => `${dir}/${file}`));
  const required = ['dist/extension.js', 'dist/dashboard/index.html', 'dist/roam/cli.mjs', 'dist/roam/supervisor.mjs', 'README.md', 'LICENSE', 'NOTICE.md', 'packages/context/LICENSE', 'packages/pstack/LICENSE', ...skills];
  if (!files.some(file => /^dist\/dashboard\/assets\/[\w-]+-[\w-]{8,}\.js$/.test(file)) || !files.some(file => /^dist\/dashboard\/assets\/[\w-]+-[\w-]{8,}\.css$/.test(file))) throw new Error('dashboard JS/CSS missing');
  if (files.some(file => file.startsWith('dist/') && (file.endsWith('.map') || file.includes('states')))) throw new Error('development dashboard files in tarball');
  const missing = required.filter(file => !files.includes(file));
  if (missing.length) { console.error(`::error::missing from tarball: ${missing.join(', ')}`); process.exitCode = 1; return; }
  if (pack.filename) {
    fs.mkdirSync('.spider/scratch/packaging', { recursive: true });
    fs.writeFileSync('.spider/scratch/packaging/pack.json', input);
  }
  console.log(`tarball contains ${files.length} files, required entries present`);
});
