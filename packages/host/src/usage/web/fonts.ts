const fontCss = "https://fonts.googleapis.com/css2?family=Google+Sans+Flex:wght@400;500;600&family=Cascadia+Code:wght@400;500&display=swap";
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
    const link = document.createElement("link");
    link.setAttribute("rel", "stylesheet"); link.setAttribute("href", fontCss); link.setAttribute("referrerpolicy", "no-referrer");
    document.head.append(link);
  } finally { if (timer) clearTimeout(timer); }
}
