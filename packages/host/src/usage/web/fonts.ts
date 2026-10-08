const loaded = new WeakSet<Document>();
export type FontMeasurer = (font: string, text: string) => number;
export async function loadFonts(document: Document, signal?: AbortSignal, measure?: FontMeasurer): Promise<void> {
  if (signal?.aborted || loaded.has(document)) return;
  loaded.add(document);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sample = "mmmmmmWWWiii0123456789";
  const width: FontMeasurer = measure ?? ((font, text) => {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return NaN;
    context.font = font;
    return context.measureText(text).width;
  });
  try {
    const local = Promise.all([
      '"Usage Text Local"',
      '"Usage Code Local"',
    ].map(async font => {
      try {
        const faces = await document.fonts?.load(`16px ${font}`);
        const available = ["monospace", "sans-serif"].some(fallback => {
          const baseline = width(`16px ${fallback}`, sample), candidate = width(`16px ${font}, ${fallback}`, sample);
          return Number.isFinite(baseline) && Number.isFinite(candidate) && candidate !== baseline;
        });
        return !!faces?.length && available;
      } catch { return false; }
    }));
    const success = await Promise.race([local.then(faces => faces.every(Boolean)), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1500); })]);
    if (success || signal?.aborted) return;
    // Direct font files obey font-src without granting remote stylesheet permission.
    if (typeof FontFace === "undefined" || !document.fonts) return;
    const textBase = "https://fonts.gstatic.com/s/googlesansflex/v23/t5sJIQcYNIWbFgDgAAzZ34auoVyXkJCOvp3SFWJbN5hF8Ju1x6sKCyp0l9sI40swNJwInycYAJzz0m7kJ4qFQOJBOjLvDSndo0SKMpKSTzwliVdHAy4bxTDHg_ugnAakp";
    const codeBase = "https://fonts.gstatic.com/s/cascadiacode/v5/qWc_B6-zq5zxD57cT5s916v3QjfzRuG9AIUcXu";
    for (const [family, weight, url] of [
      ["Google Sans Flex", "400", textBase + "8ubycs.ttf"], ["Google Sans Flex", "500", textBase + "_mbycs.ttf"],
      ["Google Sans Flex", "600", textBase + "xWcycs.ttf"], ["Google Sans Flex", "700", textBase + "yycycs.ttf"],
      ["Cascadia Code", "400", codeBase + "UMOaDP.ttf"], ["Cascadia Code", "700", codeBase + "XrPqDP.ttf"],
    ]) {
      const face = new FontFace(family!, `local("${family}"), url("${url}") format("truetype")`, { weight, display: "swap" });
      document.fonts.add(face);
      void face.load().catch(() => {}); // Offline uses the existing system fallback.
    }
  } finally { if (timer) clearTimeout(timer); }
}
