import { DIMENSION_COLUMNS } from "./dimension-values.js";
import { createHmac, randomBytes } from "node:crypto";
import { constants, openSync, closeSync, readFileSync, writeFileSync, linkSync, unlinkSync, fstatSync, fchmodSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { DashboardQueryError, type Dimension, type DashboardQueryContext, type Period, type Filter } from "./dashboard-contract.js";

import { supportedDetailId } from "./dashboard-keys.js";

export const opaqueId = (value: unknown): value is string => typeof value === "string" && /^v1_[A-Za-z0-9_-]{43}$/.test(value);
export { supportedDetailId } from "./dashboard-keys.js";
const detailDimension = (field: Dimension) => field === "session" || field === "run";
export const identityColumns: Readonly<Record<Dimension, string>> = DIMENSION_COLUMNS;
function normalizedHome(): string {
  let home = homedir();
  try { home = realpathSync(home); } catch { /* A missing home still has a safe lexical boundary. */ }
  return home.replace(/[\\/]+$/, "");
}
const meaningfulHome = (home: string) => home !== "" && !/^(?:[\\/]+|[A-Za-z]:[\\/]*)$/.test(home);
/** Two passes over capped input: source-offset home substitutions for privacy,
 * then whitespace-run path truncation for presentation. The path pass sees only
 * safe roots and never reconstructs a home from tilde.
 */
const redactEmbeddedPaths = (() => {
  type HomeForm = { text: string; folded: string; failure: number[]; firstSegmentEnd: number; rootOnly: boolean };
  type CanonicalHome = { segments: string[]; drive?: string; initials: string[] };
  const cache = new Map<string, { forms: HomeForm[]; canonical: CanonicalHome[] }>();
  const whitespace = (c: string) => {
    const code = c.charCodeAt(0);
    return code === 32 || code >= 9 && code <= 13 || code === 0xa0 || code === 0x1680 ||
      code >= 0x2000 && code <= 0x200a || code === 0x2028 || code === 0x2029 ||
      code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
  };
  const separator = (c: string) => c === "/" || c === "\\";
  const letter = (c: string) => /^[A-Za-z]$/.test(c);
  const schemeChar = (c: string) => /^[A-Za-z0-9+.-]$/.test(c);
  return (input: string, home: string, pathValue = false): string => {
    // slice is constant-cost beyond the cap; do not leave half a code point.
    let cap = Math.min(input.length, 4096);
    if (cap < input.length && /[\ud800-\udbff]/.test(input[cap - 1]!) && /[\udc00-\udfff]/.test(input[cap]!)) cap--;
    let value = input.slice(0, cap);
    const pointBefore = (index: number) => {
      let begin = index - 1;
      if (begin > 0 && (value.charCodeAt(begin) & 0xfc00) === 0xdc00 &&
        (value.charCodeAt(begin - 1) & 0xfc00) === 0xd800) begin--;
      return value.slice(begin, index);
    };
    const insensitive = process.platform === "darwin" || process.platform === "win32" || /^(?:[A-Za-z]:|\\\\|\/\/)/.test(home);
    const fold = (s: string) => {
      const text = insensitive ? s.toLowerCase() : s;
      return text.includes("%") ? text.replace(/%[0-9a-f]{1,2}/gi, hex => hex.toLowerCase()) : text;
    };
    type Search = { text: string; original: (i: number) => number; folded: (i: number) => number };
    const searches = new Map<string, Search>();
    const searchable = (s: string): Search => {
      const existing = searches.get(s);
      if (existing) return existing;
      const text = fold(s);
      if (text.length === s.length) {
        const result = { text, original: (i: number) => i, folded: (i: number) => i };
        searches.set(s, result); return result;
      }
      // Rare expanding Unicode folds need offsets in the original string.
      const original: number[] = [], folded: number[] = [];
      let position = 0, cursor = 0;
      for (const point of s) {
        const lower = fold(point);
        for (let j = 0; j < lower.length; j++) original[cursor + j] = position;
        for (let j = 0; j < point.length; j++) folded[position + j] = cursor;
        position += point.length; cursor += lower.length;
      }
      original[cursor] = position; folded[position] = cursor;
      const result = { text, original: (i: number) => original[i]!, folded: (i: number) => folded[i]! };
      searches.set(s, result); return result;
    };
    const rawHome = homedir().replace(/[\\/]+$/, "");
    const cacheKey = JSON.stringify([home, rawHome, insensitive]);
    let cached = cache.get(cacheKey);
    if (!cached) {
      // An absent/root configured home disables all home mapping. A raw root
      // must also never become a substring backstop for a valid configured home.
      const homes = new Set(meaningfulHome(home) ? [home, rawHome].filter(meaningfulHome) : []);
      for (const base of [...homes]) {
        try { homes.add(realpathSync(base).replace(/[\\/]+$/, "")); } catch { /* Synthetic/missing homes still have lexical forms. */ }
      }
      const texts = new Set<string>(), rootOnlyForms = new Set<string>();
      const canonical: CanonicalHome[] = [];
      for (const base of homes) {
        if (!meaningfulHome(base)) continue;
        for (const spelling of [base.normalize("NFC"), base.normalize("NFD")]) {
          const path = spelling.replace(/^[\\/]{2}[?.][\\/]/, "").replaceAll("\\", "/")
            .replace(/^\/(?:cygdrive\/)?([A-Za-z])\//i, "$1:/");
          const drive = /^([A-Za-z]):/.exec(path)?.[1]?.toLowerCase();
          const originals: string[] = [];
          for (const segment of path.replace(/^[A-Za-z]:/, "").split(/\/+/)) {
            if (!segment || segment === ".") continue;
            if (segment === "..") originals.pop(); else originals.push(segment);
          }
          const first = [...(originals[0] ?? "")][0] ?? "";
          const initials = [...new Set([first, ...(insensitive ? [first.toLowerCase(), first.toUpperCase()] : [])])];
          canonical.push({ segments: originals.map(fold), drive, initials: initials.flatMap(point => [fold(point),
            [...Buffer.from(point)].map(byte => "%" + byte.toString(16).padStart(2, "0")).join("")]).filter(Boolean) });
          // The literal/cap-cut backstop must recognize the same effective
          // drive homes as the component matcher, including encoded aliases.
          const aliases = drive && originals.length ? [drive, drive.toUpperCase()].flatMap(letter =>
            [`${letter}:/${originals.join("/")}`, `/${letter}/${originals.join("/")}`, `/cygdrive/${letter}/${originals.join("/")}`]) : [];
          for (const form of [spelling, ...aliases].flatMap(alias => [alias, alias.replace(/\\/g, "/"), alias.replace(/\//g, "\\")])) {
            for (const text of [form, encodeURI(form), encodeURIComponent(form),
              encodeURI(form).replace(/%20/g, "+"), encodeURIComponent(form).replace(/%20/g, "+")]) {
              texts.add(text);
              if (originals.length === 1) rootOnlyForms.add(text);
            }
          }
        }
      }
      const forms = [...texts].sort((a, b) => b.length - a.length).map(text => {
        const folded = fold(text), failure = new Array<number>(folded.length).fill(0);
        for (let i = 1, j = 0; i < folded.length; i++) {
          while (j && folded[i] !== folded[j]) j = failure[j - 1]!;
          if (folded[i] === folded[j]) j++;
          failure[i] = j;
        }
        const root = /^(?:[A-Za-z](?::|%3a))?(?:[\\/]|%(?:2f|5c))+/i.exec(folded)?.[0].length ?? 0;
        const next = folded.slice(root).search(/[\\/]|%(?:2f|5c)/i);
        const rootOnly = rootOnlyForms.has(text);
        return { text, folded, failure, firstSegmentEnd: rootOnly ? Math.min(next < 0 ? folded.length : root + next, folded.search(/\s|%20|\+/i) < 0 ? folded.length : folded.search(/\s|%20|\+/i)) : next < 0 ? folded.length : root + next, rootOnly };
      });
      if (cache.size >= 16) cache.delete(cache.keys().next().value!);
      cached = { forms, canonical };
      cache.set(cacheKey, cached);
    }
    const { forms, canonical } = cached;
    // Only the final relative marker is needed. The path pass canonicalizes
    // any earlier markers before the mapped relative root to the same …/ root.
    const relativeRoot = (source: string, start: number): number | undefined =>
      /(?:^|[^\p{L}\p{N}\p{M}._~…\/\\-])\.{1,2}$/u.test(source.slice(Math.max(0, start - 4), start)) ?
        start - (source[start - 2] === "." ? 2 : 1) : undefined;
    const pathStart = (source: string, start: number) => start === 0 ||
      !/[\p{L}\p{N}\p{M}._~…\/\\-]/u.test(source[start - 1] ?? "") ||
      /-[A-Za-z]$/.test(source.slice(Math.max(0, start - 2), start));
    type Match = { start: number; end: number; sibling?: boolean; relative?: boolean; prefix?: boolean; cut?: boolean };
    let mappedRoots = new Map<number, "home" | "sibling">();
    // Privacy substitutions only copy untouched slices and replace matched spans.
    // Offset metadata is presentation-only; no reserved input character is used.
    const replaceMatches = (source: string, matches: Match[]): string => {
      const parts: string[] = [], next = new Map<number, "home" | "sibling">();
      const offsets = [...mappedRoots].sort(([a], [b]) => a - b);
      let previous = 0, length = 0, cursor = 0;
      const append = (end: number) => {
        while (cursor < offsets.length && offsets[cursor]![0] < end) {
          const [offset, kind] = offsets[cursor]!;
          if (offset >= previous) next.set(length + offset - previous, kind);
          cursor++;
        }
        const part = source.slice(previous, end);
        parts.push(part); length += part.length;
      };
      for (const match of matches) {
        append(match.start);
        const root = match.cut ? "~…" : match.sibling || match.relative ? "…/" : match.prefix ? "…/~" : "~";
        next.set(length + (match.prefix && !match.sibling && !match.relative ? 2 : 0), root.startsWith("~") || root === "…/~" ? "home" : "sibling");
        parts.push(root); length += root.length;
        previous = match.end;
      }
      append(source.length);
      mappedRoots = next;
      return parts.join("");
    };
    // Decoding is a matching view only. Original spelling outside substitutions
    // survives, including percent escapes, plus signs, quotes and URL authority.
    const decoded = (source: string, track = true) => {
      if (!/[%+]/.test(source)) return { text: source, original: (i: number) => i };
      if (!track) return { text: source.replace(/\+|%[cd][0-9a-f](?:%[89ab][0-9a-f])|%e[0-9a-f](?:%[89ab][0-9a-f]){2}|%f[0-4](?:%[89ab][0-9a-f]){3}|%[0-7][0-9a-f]/gi, point => {
        if (point === "+") return " ";
        if (point.length === 3) return String.fromCharCode(parseInt(point.slice(1), 16));
        try { return decodeURIComponent(point); } catch { return point; }
      }), original: (i: number) => i };
      const parts: string[] = [], offsets: number[] = [];
      let length = 0;
      for (let i = 0; i < source.length;) {
        let end = i + 1, part = source[i]!;
        if (part === "+") part = " ";
        else if (part === "%") {
          const run = source.slice(i, i + 12);
          if (/^%[0-9a-f]{2}/i.test(run)) {
            // Decode UTF-8 points separately to retain exact boundary offsets.
            const byte = parseInt(run.slice(1, 3), 16);
            const count = byte < 128 ? 1 : byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 1;
            const escape = run.slice(0, count * 3);
            try { part = decodeURIComponent(escape); end = i + escape.length; } catch { /* Invalid escapes stay literal. */ }
          }
        }
        for (let j = 0; j < part.length; j++) offsets[length + j] = i;
        parts.push(part); length += part.length; i = end; offsets[length] = i;
      }
      return { text: parts.join(""), original: (i: number) => offsets[i]! };
    };
    // The home pass tracks each path's own canonical stack, independently of
    // whitespace-run truncation. No match may reach into an earlier path.
    const replaceCanonicalHomes = (raw: string): string => {
      if (!canonical.length) return raw;
      // A necessary first-point check avoids decoding unrelated escape soup.
      // Include UTF-8 percent bytes and casing variants, not just raw letters.
      const rawFold = searchable(raw).text;
      if (!canonical.some(candidate => candidate.initials.some(initial => rawFold.includes(initial)))) return raw;
      const source = decoded(raw, false).text;
      if (!/[\/\\]/.test(source)) return raw;
      const sourceFold = fold(source);
      if (!canonical.some(candidate => candidate.segments[0] && sourceFold.includes(candidate.segments[0]))) return raw;
      if (cap === input.length && !canonical.some(candidate => sourceFold.includes(candidate.segments.at(-1) ?? ""))) return raw;
      const view = source === raw ? { original: (i: number) => i } : decoded(raw);
      const stack: { text: string; start: number }[] = [];
      const matches: Match[] = [];
      const separators = [...source.matchAll(/[\/\\]+/g)];
      let previous = 0;
      let pathRoot: number | undefined, relativeStart: number | undefined, driveRoot: number | undefined;
      for (let i = 0; i < separators.length; i++) {
        const sep = separators[i]!, start = sep.index!, begin = start + sep[0].length;
        const end = separators[i + 1]?.index ?? source.length;
        const prefix = source.slice(Math.max(0, start - 24), start);
        const relative = relativeRoot(source, start);
        const preceding = source.slice((separators[i - 1]?.index ?? 0) + (separators[i - 1]?.[0].length ?? 0), start);
        if (/\s/.test(preceding) && !canonical.some(candidate => candidate.segments.includes(fold(preceding)))) {
          stack.length = 0; pathRoot = undefined; driveRoot = undefined; relativeStart = undefined;
        }
        if (relative !== undefined || pathStart(source, start) && (pathRoot === undefined || /[\s=:,; &|><!+*()\[\]{}"'`]/u.test(source.slice(separators[i - 1]?.index ?? 0, start)))) {
          pathRoot = start; driveRoot = undefined; relativeStart = relative; stack.length = 0;
        }
        const driveMatch = /(?:[\/\\]{2}[?.][\/\\])?([A-Za-z]):$/.exec(prefix);
        const drive = driveMatch && pathStart(source, start - driveMatch[0].length) ? driveMatch : null;
        const aliasDrive = /(?<!:)[\/\\](?:(?:cygdrive|mnt)[\/\\])?([A-Za-z])$/i.exec(prefix);
        const rootDrive = (/^(?:path|cwd|file):$/i.test(prefix.trim()) || drive && /[A-Za-z][a-z]:$/.test(prefix) && !/(?:^|[^\p{L}\p{N}])-[A-Za-z][A-Za-z]:$/u.test(prefix) ? null : (/(?:https?|git\+ssh|ssh|s3|ftp|file|vscode(?:-insiders)?|cursor|jetbrains):$/i.test(prefix) && sep[0].length >= 2 ? null : drive)) ?? (aliasDrive && pathStart(source, start - aliasDrive[0].length) ? aliasDrive : null);
        if (rootDrive) {
          pathRoot = start; driveRoot = start - rootDrive[0].length; relativeStart = undefined; stack.length = 0;
        }
        const scheme = source[start - 1] === ":" ? /([A-Za-z][A-Za-z0-9+.-]*):$/.exec(prefix)?.[1] : undefined;
        if (scheme && /^(?:https?|git\+ssh|ssh|s3|ftp|file|vscode(?:-insiders)?|cursor|jetbrains)$/i.test(scheme) && sep[0].length >= 2) {
          stack.length = 0; driveRoot = undefined; relativeStart = undefined;
          if (sep[0].length === 2) { pathRoot = separators[i + 1]?.index; continue; }
          pathRoot = start + 2;
        }
        const segment = source.slice(begin, end);
        if (segment === ".") continue;
        if (segment === "..") { stack.pop(); continue; }
        const search = searchable(segment);
        stack.push({ text: search.text, start });
        for (const candidate of canonical) {
          const count = candidate.segments.length, offset = stack.length - count;
          if (!count || offset < 0) continue;
          const last = candidate.segments[count - 1]!;
          if (!search.text.startsWith(last)) continue;
          const consumed = search.original(last.length);
          const sibling = /[\p{L}\p{N}\p{M}_-]/u.test(segment[consumed] ?? "");
          if (!candidate.segments.slice(0, -1).every((part, j) => stack[offset + j]!.text === part)) continue;
          if (count === 1 && (offset !== 0 || pathRoot === undefined)) continue;
          const homeStart = stack[offset]!.start;
          let from = relativeStart ?? (candidate.drive ? driveRoot : undefined) ?? pathRoot ?? stack[0]!.start;
          from = Math.max(previous, from);
          // Leave URL sentinels and authorities outside the matched path span.
          if (source[from - 1] === ":" && source.startsWith("///", from)) from += 2;
          if (from > previous && source[from - 1] === "~") from--;
          const to = sibling ? begin : begin + consumed;
          if (to <= from) continue;
          const prior = matches.at(-1);
          if (prior && view.original(from) === prior.end && pathRoot !== undefined && pathRoot < previous) {
            prior.end = view.original(to); prior.sibling = sibling;
          } else matches.push({ start: view.original(from), end: view.original(to), sibling,
            relative: relativeStart !== undefined, prefix: from < homeStart });
          previous = to;
          break;
        }
      }
      if (cap < input.length && stack.length) {
        let cut: number | undefined;
        for (const candidate of canonical) for (let depth = 1; depth <= candidate.segments.length; depth++) {
          const offset = stack.length - depth;
          if (offset < 0 || depth === 1 && stack.at(-1)!.text.length < 3) continue;
          if (!candidate.segments.slice(0, depth - 1).every((part, j) => stack[offset + j]!.text === part)) continue;
          const tail = stack.at(-1)!.text;
          if (!candidate.segments[depth - 1]!.startsWith(tail) || depth === candidate.segments.length && tail === candidate.segments[depth - 1]) continue;
          if (candidate.segments.length === 1 && (offset !== 0 || pathRoot === undefined)) continue;
          const from = candidate.drive ? driveRoot ?? stack[offset]!.start : stack[offset]!.start;
          if (from >= previous) cut = Math.min(cut ?? from, from);
        }
        if (cut !== undefined) matches.push({ start: view.original(cut), end: raw.length, cut: true });
      }
      return replaceMatches(raw, matches);
    };
    // Protect homes BEFORE choosing suffixes. Otherwise a merged outside path
    // can discard the full home while retaining a private home segment.
    const replaceHomes = (result: string): string => {
      let search = searchable(result);
      for (const form of forms) {
        const matches: { start: number; end: number; relative?: boolean }[] = [];
        let previous = 0, pos = search.text.indexOf(form.folded);
        if (pos === -1) continue;
        do {
          const start = search.original(pos), end = search.original(pos + form.folded.length);
          const relative = relativeRoot(result, start);
          const from = relative ?? start;
          if ((!form.rootOnly || pathStart(result, from)) &&
            (/%[0-9a-f]{2}|\+/i.test(form.text) || !/[\p{L}\p{N}\p{M}_-]/u.test(result[end] ?? ""))) {
            matches.push({ start: from > previous && result[from - 1] === "~" ? from - 1 : from, end, relative: relative !== undefined }); previous = end;
          }
          pos = search.text.indexOf(form.folded, pos + form.folded.length);
        } while (pos !== -1);
        if (previous) {
          result = replaceMatches(result, matches);
          search = searchable(result);
        }
      }
      return result;
    };
    value = replaceHomes(replaceCanonicalHomes(value)).replace(/~\\/g, "~/");
    const finish = (result: string) => [...result].slice(0, 160).join("");
    if (pathValue && value === "~") return meaningfulHome(home) ? "~/" : "…/";
    // KMP gives the longest home prefix at a string's end in linear time.
    const tailPrefix = (s: string, form: HomeForm): number => {
      let j = 0;
      for (let i = 0; i < s.length; i++) {
        while (j && (j === form.folded.length || s[i] !== form.folded[j])) j = form.failure[j - 1]!;
        if (s[i] === form.folded[j]) j++;
      }
      return j;
    };
    let search = searchable(value), folded = search.text;
    const atomEnds = new Int32Array(value.length + 1);
    let cutTail = value.length;
    for (const form of forms) {
      for (let pos = folded.indexOf(form.folded); pos !== -1; pos = folded.indexOf(form.folded, pos + form.folded.length)) {
        const start = search.original(pos), end = search.original(pos + form.folded.length);
        atomEnds[start] = Math.max(atomEnds[start]!, end);
      }
      if (cap < input.length) {
        const length = tailPrefix(folded, form);
        if ((length >= 8 || length >= form.firstSegmentEnd) && length < form.folded.length) cutTail = Math.min(cutTail, search.original(folded.length - length));
      }
    }
    if (cutTail < value.length) {
      value = value.slice(0, cutTail) + "~…";
      for (const offset of mappedRoots.keys()) if (offset >= cutTail) mappedRoots.delete(offset);
      mappedRoots.set(cutTail, "home");
      search = searchable(value); folded = search.text;
    }
    // Path pass: only substitute spans beginning at a detected path start.
    // Full home spellings have already become ~, including their whitespace.
    // Splitting is whitespace-only; delimiters cannot hide an absolute start.
    const runs: { start: number; end: number; lastSeparator: number; continuation: number }[] = [];
    for (let i = 0; i < value.length;) {
      if (whitespace(value[i]!)) { i++; continue; }
      const start = i;
      while (i < value.length && !whitespace(value[i]!)) {
        if (atomEnds[i]) i = atomEnds[i]!;
        if (i < value.length && !whitespace(value[i]!)) i++;
      }
      let lastSeparator = -1;
      for (let pos = start; pos < i; pos++) if (separator(value[pos]!) || pos + 3 < i && /^%(?:2f|5c)/i.test(value.slice(pos, pos + 3)) || mappedRoots.has(pos)) lastSeparator = pos;
      runs.push({ start, end: i, lastSeparator, continuation: runs.length });
    }
    // A short two-component slash token cannot start a path or bridge by
    // itself. Within an already detected path it is ambiguous, so N2 applies.
    const abbreviation = (run: string) => /^(?:[A-Za-z0-9]{1,3}\/[A-Za-z0-9]{0,3})$/.test(run);
    const roots = [...mappedRoots.keys()].sort((a, b) => a - b);
    const rootIndex = (start: number) => {
      let low = 0, high = roots.length;
      while (low < high) { const middle = (low + high) >>> 1; if (roots[middle]! < start) low = middle + 1; else high = middle; }
      return low;
    };
    const bareHome = (start: number, end: number, ownPath = true) => {
      for (let i = rootIndex(start); i < roots.length && roots[i]! < end; i++) {
        const offset = roots[i]!, kind = mappedRoots.get(offset);
        if (kind !== "home") continue;
        const prefix = value.slice(start, offset).replace(/…\/$/, "");
        if (ownPath && !/^[^\p{L}\p{N}\p{M}\/\\]*(?:-[A-Za-z]|--?[\w-]+=|[\w-]+=)?$/u.test(prefix)) continue;
        const tail = value.slice(offset + 1, end);
        if (!/[\/\\]/.test(tail) || /^[\/\\]*(?:\.)?[\p{Pe}\p{Pf}"'`.,;:!?]*$/u.test(tail) ||
          /^[\/\\][^\/\\]+[\/\\]\.\.[\/\\]*[\p{Pe}\p{Pf}"'`.,;:!?]*$/u.test(tail)) return offset;
      }
      return -1;
    };
    // A bare home glued with punctuation still has an independent path span.
    // Split the run, not its preceding prose or the earlier path's suffix.
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]!, homeRoot = bareHome(run.start, run.end, false);
      if (homeRoot <= run.start || /^%(?:2f|5c).+/i.test(value.slice(homeRoot + 1, run.end))) continue;
      let boundary = homeRoot;
      if (value.slice(Math.max(run.start, boundary - 2), boundary) === "…/") boundary -= 2;
      if (!/[\/\\]/.test(value.slice(run.start, boundary))) continue;
      // Walk opening punctuation first; a quote must not hide the glue.
      while (boundary > run.start && /['"`\p{Ps}\p{Pi}$=]/u.test(value[boundary - 1]!)) boundary--;
      if (value[boundary - 1] !== ":" && value[boundary - 1] !== ",") continue;
      boundary--;
      let lastSeparator = -1;
      for (let pos = run.start; pos < boundary; pos++) if (separator(value[pos]!)) lastSeparator = pos;
      runs.splice(i, 1, { start: run.start, end: boundary, lastSeparator, continuation: i },
        { start: boundary, end: run.end, lastSeparator: run.lastSeparator, continuation: i + 1 });
    }
    for (let i = 0; i < runs.length; i++) runs[i]!.continuation = i;
    // Reverse dynamic programming bridges separator-free words inside a path
    // segment. Explicit relative starts and terminal punctuation end a bridge.
    // Each gap is scanned once, including runs not consumed by redaction.
    let nextSeparator = runs.length - 1;
    for (let i = runs.length - 2; i >= 0; i--) {
      if (runs[i + 1]!.lastSeparator >= 0) nextSeparator = i + 1;
      const next = runs[nextSeparator]!;
      if (runs[i]!.lastSeparator < 0 || next.lastSeparator < 0) continue;
      const bareMappedHome = bareHome(next.start, next.end) >= 0;
      const nextText = value.slice(next.start, next.end);
      const nextRoot = roots[rootIndex(next.start)];
      const homePrefix = nextRoot === undefined ? "" : value.slice(next.start, nextRoot);
      const prefixedHome = nextRoot !== undefined && nextRoot < next.end && mappedRoots.get(nextRoot) === "home" &&
        /^(?:["'`<\p{Ps}\p{Pi}$]*…\/|(?:[\w-]+[:,=]|["'`<\p{Ps}\p{Pi}$]+)[^\/\\\p{Pe}\p{Pf}>]*?(?:…\/)?)$/u.test(homePrefix) &&
        !/%(?:2f|5c)/i.test(homePrefix);
      const newStart = /^(?:[\\/]|…\/~|~[\\/]|[A-Za-z]:[\\/]|\.{1,2}[\\/])/.test(nextText) ||
        /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value.slice(next.start, next.end));
      if (runs[i]!.lastSeparator >= 0 && next.lastSeparator >= 0 && next.start < cutTail &&
        !/[,;]$/.test(value.slice(runs[i]!.start, runs[i]!.end)) &&
        !prefixedHome && !bareMappedHome && bareHome(runs[i]!.start, runs[i]!.end) < 0 && !/^\.{1,2}[\\/]/.test(value.slice(next.start, next.end)) &&
        (nextSeparator === i + 1 || !newStart)) runs[i]!.continuation = next.continuation;
    }
    // Whether the next segment contains an escape, indexed once. Never split
    // the entire remaining path at each slash in a long relative marker chain.
    const encodedSegments = new Uint8Array(value.length + 1);
    let encodedSegment = false;
    for (let i = value.length - 1; i >= 0; i--) {
      if (separator(value[i]!) || whitespace(value[i]!)) encodedSegment = false;
      else if (value[i] === "%" && /^%[0-9a-f]{2}/i.test(value.slice(i, i + 3))) encodedSegment = true;
      encodedSegments[i] = encodedSegment ? 1 : 0;
    }
    const firstPath = (start: number, end: number, lastSlash: number): number => {
      const run = value.slice(start, end);
      if (start >= cutTail || abbreviation(run)) return -1;
      let explicitlyRelative = false;
      if (pathValue && /^(?:\.{1,2}[\\/]|[A-Za-z0-9_.-]+[\\/]|[A-Za-z]:[^\\/])/.test(run) &&
        !run.startsWith("-") && !run.includes("://")) return -1;
      // A plain relative word is not an absolute root. Compact flags and all
      // punctuation prefixes still reach the first slash rule below.
      const relative = /^[A-Za-z0-9_-]{2,}\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(run) && !run.startsWith("-") && !/-[A-Za-z]\//.test(run) &&
        !forms!.some(form => folded.startsWith(form.folded, search.folded(start)));
      for (let i = start; i < end; i++) {
        if (separator(value[i]!) && value[i - 1] === ".") {
          let marker = i - 1;
          if (value[marker - 1] === ".") marker--;
          if (marker === start || !/[\p{L}\p{N}\p{M}._~/\\-]/u.test(pointBefore(marker))) explicitlyRelative = true;
        }
        // Find schemes by their :// sentinel, once, with a disjoint backward
        // scan. Preserve scheme and authority, then examine only the URL path.
        if (value.startsWith("://", i)) {
          let begin = i;
          while (begin > start && schemeChar(value[begin - 1]!)) begin--;
          while (begin < i && !letter(value[begin]!)) begin++;
          const boundary = begin === start || !/[\p{L}\p{N}]/u.test(pointBefore(begin));
          const driveLike = /-[A-Za-z]{2}$/.test(value.slice(Math.max(start, begin - 1), i));
          const scheme = value.slice(begin, i);
          const knownScheme = /^(?:https?|git\+ssh|ssh|s3|ftp|file|vscode(?:-insiders)?|cursor|jetbrains)$/i.test(scheme);
          // A word glued to any drive can also spell an unknown scheme.
          // Only a complete recognized scheme earns authority preservation.
          // An empty authority exposes nothing; its absolute path is scanned.
          if (!driveLike && !knownScheme && /[A-Za-z]$/.test(scheme) && !separator(value[i + 3] ?? "")) return begin;
          if (i - begin >= 2 && boundary && !driveLike) {
            let path = i + 3;
            if (!(letter(value[path] ?? "") && value[path + 1] === ":" && separator(value[path + 2] ?? ""))) {
              while (path < end && !separator(value[path]!) && !/^%(?:2f|5c)/i.test(value.slice(path, path + 3)) && !value.startsWith("~/", path) && !value.startsWith("…/~", path)) path++;
            }
            explicitlyRelative = false;
            i = path - 1;
            continue;
          }
        }
        if (letter(value[i]!) && value[i + 1] === ":" && separator(value[i + 2] ?? "") && !value.startsWith("://", i + 1)) {
          let begin = i;
          while (begin > start && schemeChar(value[begin - 1]!)) begin--;
          if ((!explicitlyRelative || begin === i) && !/^(?:path|cwd|file)$/i.test(value.slice(begin, i + 1))) return begin;
        }
        if (i + 3 < end && /^%(?:2f|5c)/i.test(value.slice(i, i + 3))) return i;
        if (value.startsWith("…/~", i) || value.startsWith("\\\\", i) || value.startsWith("~/", i) || mappedRoots.has(i) && i <= lastSlash) return i;
        // Single-backslash roots are conservatively private too. Only relative
        // separators are exempt, not absolute starts glued after relative prose.
        if (separator(value[i]!) && (i < lastSlash || /%[0-9a-f]{2}/i.test(run)) && (!relative || value[i] === "\\")) {
          const relativeSeparator = explicitlyRelative &&
            !encodedSegments[i + 1] &&
            /[\p{L}\p{N}\p{M}\p{Extended_Pictographic}._~/\\-]/u.test(pointBefore(i)) &&
            !/(?:-[A-Za-z]|[\p{L}\p{N}]\.)$/u.test(value.slice(Math.max(start, i - 3), i));
          if (!relativeSeparator) return i;
        }
      }
      return -1;
    };
    const pieces: string[] = [];
    let previous = 0;
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r]!;
      const last = run.continuation, end = runs[last]!.end;
      const path = runs[last]!.lastSeparator < 0 ? -1 : firstPath(run.start, run.end, runs[last]!.lastSeparator);
      pieces.push(value.slice(previous, path < 0 ? run.end : path));
      if (path >= 0) {
        r = last;
        const bodyEnd = Math.min(end, cutTail);
        let rawBody = value.slice(path, bodyEnd);
        // A mapped home inside an outside path resets the presentation root.
        // No pre-home segment can become part of the visible suffix.
        let rootOffset = 0;
        const bareSubstitutions = mappedRoots.get(path) === "home" && !/[\/\\]|%(?:2f|5c)/i.test(rawBody);
        for (let i = rootIndex(path); i < roots.length && roots[i]! < bodyEnd; i++) {
          const offset = roots[i]!;
          if ( (offset === path || !rawBody.startsWith("~/") && !bareSubstitutions ||
            /[\p{L}\p{N}\p{M}._~\/\\\s-]/u.test(value[offset - 1] ?? ""))) rootOffset = offset - path;
        }
        rawBody = rawBody.slice(rootOffset);
        // Opaque encoded tails retain their established spelling unless a
        // home-named segment needs a real separator for its safe presentation.
        let opaqueHome = mappedRoots.get(path + rootOffset) === "home" && !/[\/\\]/.test(rawBody);
        if (opaqueHome && rawBody.includes("%")) {
          const decodedBody = decoded(rawBody, false).text;
          if (canonical.some(candidate => candidate.segments.some(segment => fold(decodedBody).includes(segment)))) {
            rawBody = decodedBody; opaqueHome = false;
          }
        }
        if (opaqueHome) pieces.push(rawBody);
        else {
          const root = /^(?:[~…][\/\\]|[A-Za-z]:[\/\\]+|[\/\\]+|(?:%(?:2f|5c))+)/i.exec(rawBody)?.[0] ?? "";
          const rawSegments = rawBody.slice(root.length).split(/[\/\\]+|(?:%(?:2f|5c))+/i).filter(Boolean);
          const segments: string[] = [];
          let escapedTilde = false, traversal = false;
          for (let segment of rawSegments) {
            // Decode only potential dot markers here, and only the kept tail
            // below. Discarded UTF-8 segments need no presentation decoding.
            if (/^%2e/i.test(segment)) segment = decoded(segment, false).text;
            const dot = /^\.{1,2}(?=\s|$)/.exec(segment)?.[0];
            if (dot) {
              traversal = true;
              if (dot === "..") { if (!segments.length && root.startsWith("~")) escapedTilde = true; segments.pop(); }
              segment = segment.slice(dot.length).trimStart();
            }
            if (segment) segments.push(segment);
          }
          const underHome = meaningfulHome(home) && !escapedTilde && root.startsWith("~");
          if (underHome && segments.length <= 2 && !traversal && !rawBody.includes("%")) pieces.push(rawBody.replaceAll("\\", "/"));
          else pieces.push((underHome ? "~/" : "…/") + segments.slice(-2).map(segment =>
            segment.includes("%") ? decoded(segment, false).text : segment).join("/"));
        }
        pieces.push(value.slice(bodyEnd, end));
      }
      previous = path < 0 ? run.end : end;
    }
    pieces.push(value.slice(previous));
    const result = pieces.join("");
    return finish(result);
  };
})();
/** Presentation only. Never use labels as filesystem inputs or query identities. */
export function dashboardLabel(field: Dimension, value: string | null, home: string = normalizedHome()): string | null {
  if (value === null) return null;
  if (detailDimension(field)) return supportedDetailId(value) ? value : "unsupported id";
  home = home.replace(/[\\/]+$/, "");
  value = redactEmbeddedPaths(value, home, field === "project" || field === "repo");
  return [...value].slice(0, 160).join("");
}
const initialized = new WeakMap<DashboardQueryContext["db"], { key: (field: Dimension, value: string | null) => string | null;
  revision?: string; lookups: Map<string, Map<string, string>> }>();
const identityFailures = new WeakMap<DashboardQueryContext["db"], number>();
const unavailable = (): never => { throw new DashboardQueryError("identity-unavailable"); };
const ignoreCleanup = (cleanup: () => void) => { try { cleanup(); } catch { /* Never mask the original failure. */ } };
function readSalt(file: string): Buffer {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let fd: number | undefined;
  try {
    try { fd = openSync(file, flags); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporary = file + "." + randomBytes(12).toString("hex");
      let output: number | undefined;
      try {
        output = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        // Explicitly restore owner bits even under a restrictive umask.
        fchmodSync(output, 0o600);
        writeFileSync(output, randomBytes(32));
        closeSync(output); output = undefined;
        try { linkSync(temporary, file); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "EEXIST") throw failure; }
      } finally {
        if (output !== undefined) ignoreCleanup(() => closeSync(output!));
        ignoreCleanup(() => unlinkSync(temporary));
      }
      fd = openSync(file, flags);
    }
    let info = fstatSync(fd);
    // Exclusive publication briefly leaves the creator's temporary name linked.
    // Reopen a few times, sleeping between checks, then still require nlink=1.
    // Never turn a persistent hardlink into an accepted salt or spin the CPU.
    const deadline = performance.now() + 100;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (info.isFile() && info.nlink === 2 && performance.now() < deadline) {
      closeSync(fd); fd = undefined;
      Atomics.wait(wait, 0, 0, Math.min(10, Math.max(0, deadline - performance.now())));
      fd = openSync(file, flags); info = fstatSync(fd);
    }
    if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid()) ||
      (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) || info.size !== 32) unavailable();
    const salt = readFileSync(fd);
    if (salt.length !== 32) unavailable();
    return salt;
  } catch { return unavailable(); }
  finally { if (fd !== undefined) ignoreCleanup(() => closeSync(fd!)); }
}
/** Task 6 owns the shared per-ledger identity helper used by all dashboard views.
 * Publish a complete 0600 salt by exclusive hard link, never replace unsafe salts.
 * SQL must invoke explorer_id only AFTER grouping. The memo hashes each distinct
 * field/value once per connection, not once per counted row or pivot tuple.
 */
export function initializeIds(ctx: DashboardQueryContext): void {
  if (initialized.has(ctx.db)) return;
  const file = ctx.db.raw.name + ".explorer-salt";
  if ((identityFailures.get(ctx.db) ?? 0) > Date.now()) unavailable();
  let salt: Buffer;
  try { salt = readSalt(file); }
  catch (error) { identityFailures.set(ctx.db, Date.now() + 5000); throw error; }
  identityFailures.delete(ctx.db);
  const memo = new Map<string, string>();
  const key = (field: Dimension, value: string | null): string | null => {
    if (value === null) return null;
    if (detailDimension(field)) return supportedDetailId(value) ? value : null;
    const input = JSON.stringify([field, value]);
    let id = memo.get(input);
    if (!id) { id = "v1_" + createHmac("sha256", salt).update(input).digest("base64url"); memo.set(input, id); }
    return id;
  };
  const home = normalizedHome();
  ctx.db.raw.function("explorer_id", { deterministic: true }, key);
  ctx.db.raw.function("explorer_label", { deterministic: true }, (field: Dimension, value: string | null) => dashboardLabel(field, value, home));
  ctx.db.raw.function("explorer_fold", { deterministic: true }, (value: string | null) => value === null ? null : value.toLowerCase());
  ctx.db.raw.function("explorer_detail_key", { deterministic: true }, (value: string | null) => value === null ? null : supportedDetailId(value) ? value : "");
  initialized.set(ctx.db, { key, lookups: new Map() });
}
export function dashboardKey(ctx: DashboardQueryContext, field: Dimension, value: string | null): string | null {
  initializeIds(ctx); return initialized.get(ctx.db)!.key(field, value);
}
/** Resolve explicit ids, never guess from their shape. A range-indexed DISTINCT
 * cache is scoped to the snapshot revision and period. Uncounted stored values
 * may resolve but still cannot bypass counted selection. No all-time calls scan.
 */
/** Typeahead alone batches dictionary misses, keeping its request cap at two SELECTs. */
export function primeFilterIds(ctx: DashboardQueryContext, filters: readonly Filter[], period: Period): void {
  const fields = [...new Set(filters.filter(filter => filter.kind === "id" && filter.value !== null && !detailDimension(filter.field)).map(filter => filter.field))];
  if (!fields.length) return;
  initializeIds(ctx);
  const state = initialized.get(ctx.db)!;
  if (state.revision !== ctx.revision) { state.lookups.clear(); state.revision = ctx.revision; }
  const missing = fields.filter(field => !state.lookups.has(JSON.stringify([field, period.start, period.end])));
  if (!missing.length) return;
  const sql = missing.map(field => {
    const column = field === "day" ? "strftime('%Y-%m-%d', c.ts / 1000, 'unixepoch')" : `c.${identityColumns[field]}`;
    return `SELECT DISTINCT '${field}' AS field, ${column} AS value FROM calls c INDEXED BY calls_period_read WHERE c.ts >= ? AND c.ts < ? AND ${column} IS NOT NULL`;
  }).join(" UNION ALL ");
  const rows = ctx.db.prepare(sql).all(...missing.flatMap(() => [period.start, period.end])) as { field: Dimension; value: string }[];
  for (const field of missing) {
    const lookup = new Map(rows.filter(row => row.field === field).map(row => [state.key(field, row.value)!, row.value]));
    if (state.lookups.size >= 32) state.lookups.delete(state.lookups.keys().next().value!);
    state.lookups.set(JSON.stringify([field, period.start, period.end]), lookup);
  }
}
export function resolveFilterId(ctx: DashboardQueryContext, field: Dimension, id: string, period: Period): string {
  if (detailDimension(field)) {
    if (!supportedDetailId(id)) throw new DashboardQueryError("unknown-filter-id");
    return id;
  }
  initializeIds(ctx);
  const state = initialized.get(ctx.db)!;
  if (state.revision !== ctx.revision) { state.lookups.clear(); state.revision = ctx.revision; }
  const cacheKey = JSON.stringify([field, period.start, period.end]);
  let lookup = state.lookups.get(cacheKey);
  if (!lookup) {
    const column = field === "day" ? "strftime('%Y-%m-%d', c.ts / 1000, 'unixepoch')" : `c.${identityColumns[field]}`;
    const rows = ctx.db.prepare(`SELECT DISTINCT ${column} AS value FROM calls c INDEXED BY calls_period_read WHERE c.ts >= ? AND c.ts < ? AND ${column} IS NOT NULL`)
      .all(period.start, period.end) as { value: string }[];
    lookup = new Map(rows.map(row => [state.key(field, row.value)!, row.value]));
    // Bound retained windows, without ever falling back to a per-row HMAC predicate.
    if (state.lookups.size >= 32) state.lookups.delete(state.lookups.keys().next().value!);
    state.lookups.set(cacheKey, lookup);
  }
  const value = lookup.get(id);
  if (value === undefined) throw new DashboardQueryError("unknown-filter-id");
  return value;
}
