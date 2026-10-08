const loaded = new WeakSet<Document>();
export type FontMeasurer = (font: string, text: string) => number;
const families = [
  { local: "Usage Text Local", family: "Fira Sans", files: [["400", "https://fonts.gstatic.com/s/firasans/v18/va9E4kDNxMZdWfMOD5Vvl4jLazX3dA.woff2"], ["500", "https://fonts.gstatic.com/s/firasans/v18/va9B4kDNxMZdWfMOD5VnZKveRhf6Xl7Glw.woff2"], ["600", "https://fonts.gstatic.com/s/firasans/v18/va9B4kDNxMZdWfMOD5VnSKzeRhf6Xl7Glw.woff2"], ["700", "https://fonts.gstatic.com/s/firasans/v18/va9B4kDNxMZdWfMOD5VnLK3eRhf6Xl7Glw.woff2"]] },
  { local: "Usage Code Local", family: "Cascadia Code", files: [["400", "https://fonts.gstatic.com/s/cascadiacode/v5/qWcsB6-zq5zxD57cT5s916v3aDvbtxsis4I.woff2"], ["700", "https://fonts.gstatic.com/s/cascadiacode/v5/qWcsB6-zq5zxD57cT5s916v3aDvbtxsis4I.woff2"]] },
  { local: "Usage Wordmark Local", family: "Bebas Neue", files: [["400", "https://fonts.gstatic.com/s/bebasneue/v16/JTUSjIg69CK48gW7PXoo9Wlhyw.woff2"]] },
];
export async function loadFonts(document: Document, signal?: AbortSignal, measure?: FontMeasurer): Promise<void> {
  if (signal?.aborted || loaded.has(document)) return;
  loaded.add(document);
  const width: FontMeasurer = measure ?? ((font, text) => { const context = document.createElement("canvas").getContext("2d"); if (!context) return NaN; context.font = font; return context.measureText(text).width; });
  await Promise.all(families.flatMap(spec => spec.files.map(async ([weight, url]) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const available = await Promise.race([
        (async () => { const faces = await document.fonts?.load(`${weight} 16px "${spec.local}"`); return !!faces?.length && ["monospace", "sans-serif"].some(fallback => { const a = width(`${weight} 16px ${fallback}`, "mmmmWWWiii012345"), b = width(`${weight} 16px "${spec.local}", ${fallback}`, "mmmmWWWiii012345"); return Number.isFinite(a) && Number.isFinite(b) && a !== b; }); })().catch(() => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1500); }),
      ]);
      if (available || signal?.aborted || typeof FontFace === "undefined" || !document.fonts) return;
      const face = new FontFace(spec.family, `url("${url}")`, { weight, display: "swap" });
      document.fonts.add(face); void face.load().catch(() => {});
    } finally { if (timer) clearTimeout(timer); }
  })));
}
