// Independent wire-output oracle, not the production tokenizer. Root markers
// also catch paths hidden inside the last two segments of a redacted label.
export function homeForms(home: string): string[] {
  const raw = [home, home.replace(/\//g, "\\"), home.replace(/\\/g, "/")]
    .flatMap(value => [value.normalize("NFC"), value.normalize("NFD")]);
  return [...new Set(raw.flatMap(value => [value, encodeURI(value), encodeURIComponent(value)]).flatMap(value =>
    [value, value.replace(/%[0-9A-F]{2}/g, s => s.toLowerCase()), value.replace(/%20/gi, "+")]))];
}
const decode = (text: string) => text.replace(/(?:%[0-9a-f]{2}|\+)+/gi, encoded => {
  try { return decodeURIComponent(encoded.replaceAll("+", " ")); } catch { return encoded; }
}).normalize("NFC");
/** Positional allowance: remove home-prefix occurrences from the INPUT first.
 * A repeated word in a relative tail, unrelated path or prose is not private.
 * The seeded generators use distinctive home names, so an exposed home segment
 * cannot borrow an allowance from a coincidentally named unrelated segment.
 */
export function homeSegmentLeaks(label: string, homes: readonly string[], source: string): string[] {
  const insensitive = process.platform === "darwin" || process.platform === "win32" || homes.some(home => /^(?:[A-Za-z]:|\\\\|\/\/)/.test(home));
  const canonical = (text: string) => (insensitive ? text.normalize("NFC").toLowerCase() : text.normalize("NFC"))
    .replace(/%[0-9a-f]{2}/gi, hex => hex.toLowerCase());
  const active = homes.map(home => home.replace(/[\\/]+$/, "")).filter(home => home && !/^[A-Za-z]:$/.test(home));
  const forms = active.flatMap(home => homeForms(home).map(form => ({ home, form }))).sort((a, b) => b.form.length - a.form.length);
  const seen = new Set<string>();
  if (/~[\\/]/.test(source) && active[0]) seen.add(active[0]);
  let outsideHome = canonical(source);
  for (const { home, form } of forms) {
    const spelling = canonical(form);
    let at = outsideHome.indexOf(spelling);
    while (at !== -1) {
      const end = at + spelling.length;
      // Encoded home atoms may be glued to another label value. Plain sibling
      // directory names such as home-other are not occurrences of the home.
      if (/%[0-9a-f]{2}|\+/i.test(form) || !/[\p{L}\p{N}\p{M}_-]/u.test(outsideHome[end] ?? "")) {
        seen.add(home);
        outsideHome = outsideHome.slice(0, at) + "~" + outsideHome.slice(end);
        at = outsideHome.indexOf(spelling, at + 1);
      } else at = outsideHome.indexOf(spelling, end);
    }
  }
  const output = decode(canonical(label)), allowed = decode(outsideHome);
  const leaks: string[] = [];
  for (const segment of new Set(active.filter(home => seen.has(home)).flatMap(home => home.replace(/^[A-Za-z]:/, "").split(/[\\/]+/).filter(Boolean)))) {
    const escaped = canonical(segment).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp("(?:^|[\\\\/])" + escaped + "(?=[\\\\/]|\\s|$)", "gu");
    if ((output.match(pattern)?.length ?? 0) > (allowed.match(pattern)?.length ?? 0)) leaks.push(`home prefix segment ${segment}`);
  }
  return leaks;
}
export function labelLeaks(label: string, homes: readonly string[], markers: readonly string[] = [], source?: string): string[] {
  const folded = process.platform === "darwin" || process.platform === "win32" ? label.toLowerCase() : label;
  const leaks = homes.flatMap(home => homeForms(home)).filter(form => folded.includes(
    process.platform === "darwin" || process.platform === "win32" ? form.toLowerCase() : form));
  if (source !== undefined) leaks.push(...homeSegmentLeaks(label, homes, source));
  // Exclude authority (not filesystem segments), abbreviated/redacted and
  // explicitly relative paths before looking for three raw rooted segments.
  const paths = label.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s\\]*/g, "")
    .replace(/(?:~\/|\.\.\/|\.\/)[^\s]*/g, "");
  for (const match of paths.matchAll(/(?=(?:[A-Za-z]:[\\/]|\\\\|\/)(?:[^\s\\/]+[\\/]){2}[^\s\\/]+)/g)) {
    if (paths[match.index! - 1] !== "…") { leaks.push("raw absolute path"); break; }
  }
  if (/…\/(?:[^\s\\/]+[\\/]){2}[^\s\\/]+/.test(label)) leaks.push("more than two redacted segments");
  for (const marker of markers) if (label.includes(marker)) leaks.push(`root segment ${marker}`);
  return leaks;
}
