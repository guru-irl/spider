import { main } from "./cli";

void main(process.argv.slice(2), { out: text => process.stdout.write(text), err: text => process.stderr.write(text) })
  .then(code => { process.exitCode = code; }, () => { process.stderr.write("Roaming command failed.\n"); process.exitCode = 1; });
