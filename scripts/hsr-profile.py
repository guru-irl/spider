import re
import sys
from pathlib import Path


path = Path(sys.argv[1])
source = path.read_text()
if sys.argv[2] == 'profile-base':
    start = source.index('    const before = await readFile(path), out: string[]')
    decline = source.index("    expect(await runHerdrCli(['setup', '--decline-native-keys',", start)
    conflict = source.index("    expect(await runHerdrCli(['setup', '--merge-native-keys', '--decline-native-keys'", decline)
    next_case = source.index('\n  });', conflict)
    source = (source[:start] + "    const out: string[] = [], errors: string[] = [];\n"
        "    const ports = { ...f.ports, stdout: (text: string) => out.push(text), stderr: (text: string) => errors.push(text) };\n"
        + source[decline:conflict] + source[next_case:])
traced, n = re.subn(r"\brunHerdrCli\((\[(?:'setup'|'rollback'))", r"timedCli(\1", source)
if not n:
    raise SystemExit('No setup calls to trace')
path.write_text(traced + '''
async function timedCli(...args: Parameters<typeof runHerdrCli>) {
  const [argv] = args;
  const label = argv.slice(0, argv.indexOf('--config')).join(' ');
  console.log(`HSR START ${Date.now()} ${label}`);
  try { return await runHerdrCli(...args); }
  finally { console.log(`HSR END ${Date.now()} ${label}`); }
}
''')
