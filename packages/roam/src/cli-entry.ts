const argv: string[] = process.argv.slice(2);

async function run(): Promise<number> {
  if (argv.length === 5 && argv[0] === "--global-root" && argv[2] === "roam" && argv[3] === "intercom" && argv[4] === "exchange") {
    // These imports refer to independently built sibling entries.
    // @ts-expect-error The build creates this runtime entry.
    const helper: typeof import("./intercom-helper") = await import("./intercom-helper.mjs");
    return helper.main(argv[1]);
  }
  // @ts-expect-error The build creates this runtime entry.
  const cli: typeof import("./cli") = await import("./cli-main.mjs");
  return cli.main(argv, { out: text => process.stdout.write(text), err: text => process.stderr.write(text) });
}
void run().then(code => { process.exitCode = code; }, () => { process.stderr.write("Roaming command failed.\n"); process.exitCode = 1; });
