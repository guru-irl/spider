// Verify npm's file list; assert-bundle.mjs separately verifies the tarball bytes.
const fs = require('node:fs');
const roamEntries = require('./roam-entries.json');
let input = '';
process.stdin.on('data', chunk => { input += chunk; }).on('end', () => {
  const [pack] = JSON.parse(input);
  const files = pack.files.map(file => file.path);
  const skillDirs = ['packages/superpowers/skills', 'packages/pstack/skills', 'packages/intercom/skills'];
  const skills = skillDirs.flatMap(dir => fs.readdirSync(dir, { recursive: true })
    .filter(file => file === 'SKILL.md' || file.endsWith('/SKILL.md')).map(file => `${dir}/${file}`));
  const required = ['dist/extension.js', 'dist/extension.js.ready', 'dist/intercom/broker.mjs', 'dist/dashboard/index.html',
    ...Object.keys(roamEntries).map(mode => `dist/roam/${mode}.mjs`), 'packages/herdr/assets/shared/presentations.js',
    'packages/herdr/assets/look/native-navigation-0.1.16.json', 'packages/herdr/assets/look/native-panel-0.1.16.json', 'packages/herdr/assets/look/native-picker-0.1.16.json',
    'packages/herdr/assets/look/pane-navigation-b.json', 'packages/herdr/assets/look/pane-panel-b.json', 'packages/herdr/assets/look/pane-picker-b.json', 'packages/herdr/assets/shared/pane-service-state.js',
    'scripts/link.mjs', 'scripts/dev-link.mjs', 'scripts/link-roam.mjs', 'scripts/extension-shim.mjs', 'scripts/package-extension.ts', 'scripts/pi-agent-dir.mjs',
    'README.md', 'LICENSE', 'NOTICE.md', 'packages/context/LICENSE', 'packages/pstack/LICENSE', 'packages/intercom/LICENSE', 'packages/intercom/ORIGIN.md', 'scripts/intercom-switchover.mjs', ...skills];
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
