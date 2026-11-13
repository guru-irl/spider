export async function unexpectedBootstrapProbe(): Promise<never> {
  throw new Error("unexpected bootstrap probe");
}
