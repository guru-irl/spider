import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { runHerdrCli } from '../setup/cli.js';
import { createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), import.meta.url.includes('/packages/herdr/src/bin/') ? '../../../..' : '../..');
const argv = process.argv.slice(2);
if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) process.exit(await runHerdrCli(argv));
const ports = createProductionHerdrCliPorts(root);
let code = 1;
try { code = await runHerdrCli(argv[0] === 'ipc' ? process.argv : argv, ports); }
finally { await ports.dispose(); }
process.exit(code);
