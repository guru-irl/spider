import re
import sys
from pathlib import Path


path = Path(sys.argv[1])
source = path.read_text()
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
