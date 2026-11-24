import { requestHubControl } from "./control-socket";

export async function waitReady(file: string, timeoutMs = 4000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const result = await requestHubControl(file, { op: "status" }, { timeoutMs: Math.min(500, end - Date.now()) });
      if (result.code === 0 && result.value?.enabled === true) return true;
    } catch { /* The service may still be starting. */ }
    const remaining = end - Date.now();
    if (remaining > 0) await new Promise<void>(done => setTimeout(done, Math.min(50, remaining)));
  }
  return false;
}
