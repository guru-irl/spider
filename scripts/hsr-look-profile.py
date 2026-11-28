from pathlib import Path


root = Path('packages/host/src/__tests__')
file = root / 'herdr-setup-releases.test.ts'
source = file.read_text()
begin = source.index('  test(`${version} production setup stages')
end = source.index('  test(`${version} offers native keys without writing', begin)
tracked = source[begin:end].replace('await setupHerdr(', 'await timedSetup(')
if tracked.count('await timedSetup(') != 4:
    raise SystemExit('Expected four setup calls in the look cases')
file.write_text(source[:begin] + tracked + source[end:] + '''
async function timedSetup(request: Parameters<typeof setupHerdr>[0], parts: Parameters<typeof setupHerdr>[1]) {
  const start = performance.now();
  const label = request.config.look?.windowBlur === false ? 'blur off' : 'regular';
  try {
    return await setupHerdr(request, { ...parts, verify: async req => {
      const verifyStart = performance.now();
      try { return await parts.verify(req); }
      finally { console.log(`HSR_LOOK verify ${label}: ${Math.round(performance.now() - verifyStart)}ms`); }
    } });
  } finally { console.log(`HSR_LOOK setup ${label}: ${Math.round(performance.now() - start)}ms`); }
}
''')
file = root / 'herdr-setup-fixture.ts'
source = file.read_text()
old = "  await writeFile(join(root, 'dist/herdr/remote-runtime.mjs'), await buildRuntimeArtifact());"
new = '''  const buildStart = performance.now();
  await writeFile(join(root, 'dist/herdr/remote-runtime.mjs'), await buildRuntimeArtifact());
  if (options.localOnly) console.log(`HSR_LOOK stage runtime: ${Math.round(performance.now() - buildStart)}ms`);'''
if old not in source:
    raise SystemExit('Missing fixture artifact build')
file.write_text(source.replace(old, new))
