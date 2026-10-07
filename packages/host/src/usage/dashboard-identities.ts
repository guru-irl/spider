import { DIMENSION_COLUMNS } from "./dimension-values.js";
import { createHmac, randomBytes } from "node:crypto";
import { constants, openSync, closeSync, readFileSync, writeFileSync, linkSync, unlinkSync, fstatSync, fchmodSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { sep, posix, win32 } from "node:path";
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
function pathLabel(value: string, home: string): string {
  const compare = process.platform === "win32" ? value.toLowerCase() : value;
  const base = process.platform === "win32" ? home.toLowerCase() : home;
  if (compare === base || compare.startsWith(base + sep)) return "~" + value.slice(home.length);
  return "…/" + value.split(/[\\/]+/).filter(Boolean).slice(-2).join("/");
}
// Only home-origin traversal may hide a surviving home prefix. Shared words
// in an unrelated path or in a home-relative tail remain ordinary segments.
function outsideHomeTail(segments: string[], home: string): string[] {
  const windows = /^(?:[A-Za-z]:|\\\\|\/\/)/.test(home), syntax = windows ? win32 : posix;
  const parents = syntax.normalize(home).replace(/^[A-Za-z]:/, "").split(/[\\/]+/).filter(Boolean);
  const fold = (value: string) => windows || process.platform === "darwin" || process.platform === "win32" ? value.toLowerCase() : value;
  let shared = 0;
  while (shared < segments.length && shared < parents.length && fold(segments[shared]!) === fold(parents[shared]!)) shared++;
  return segments.slice(shared);
}
function normalizedPathLabel(path: string, home: string): string {
  const hasHome = meaningfulHome(home), homeOrigin = path === "~" || path.startsWith("~/");
  if (path === "~") path = hasHome ? home : "";
  if (path.startsWith("~/")) path = hasHome ? home + path.slice(1) : path.slice(2);
  const windows = /^[A-Za-z]:|^\\\\|^\/\//.test(path), syntax = windows ? win32 : posix;
  const normalized = syntax.normalize(path), base = syntax.normalize(home);
  const compare = windows ? normalized.toLowerCase() : normalized;
  const homeCompare = windows ? base.toLowerCase() : base;
  if (hasHome && syntax.isAbsolute(normalized) && (compare === homeCompare || compare.startsWith(homeCompare.replace(/[\\/]+$/, "") + syntax.sep))) {
    return "~/" + normalized.slice(base.replace(/[\\/]+$/, "").length).replace(/^[\\/]+/, "").replaceAll("\\", "/");
  }
  // Only real segments survive relative/upward paths, even after normalization.
  const segments = normalized.replace(/^[A-Za-z]:/, "").split(/[\\/]+/).filter(part => part && part !== "." && part !== "..");
  return pathLabel((homeOrigin ? outsideHomeTail(segments, base) : segments).join("/"), "/");
}
/** Capped whitespace runs, not delimiter-driven tokens. An outside path consumes
 * the rest of its run. Separator-bearing continuation runs stay private until
 * plain prose. Home spellings are mapped before path detection and again as a
 * final backstop, including encoded/alternate separators and cap-cut prefixes.
 */
const redactEmbeddedPaths = (() => {
  type HomeForm = { text: string; folded: string; failure: number[]; firstSegmentEnd: number; rootOnly: boolean };
  type CanonicalHome = { segments: string[]; drive?: string };
  const cache = new Map<string, { forms: HomeForm[]; canonical: CanonicalHome[] }>();
  const whitespace = (c: string) => /\s/.test(c);
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
    const searchable = (s: string) => {
      const text = fold(s);
      if (text.length === s.length) return { text, original: (i: number) => i, folded: (i: number) => i };
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
      return { text, original: (i: number) => original[i]!, folded: (i: number) => folded[i]! };
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
          canonical.push({ segments: originals.map(fold), drive });
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
        return { text, folded, failure, firstSegmentEnd: next < 0 ? folded.length : root + next, rootOnly };
      });
      if (cache.size >= 16) cache.delete(cache.keys().next().value!);
      cached = { forms, canonical };
      cache.set(cacheKey, cached);
    }
    const { forms, canonical } = cached;
    const relativeRoot = (source: string, start: number) =>
      /(?:^|[^\p{L}\p{N}\p{M}._~\/\\-])\.{1,2}$/u.test(source.slice(Math.max(0, start - 4), start));
    const pathStart = (source: string, start: number) => start === 0 ||
      !/[\p{L}\p{N}\p{M}._~…\/\\-]/u.test(source[start - 1] ?? "");
    let mappedRoots = new Map<number, "home" | "sibling">();
    // Keep home-root offsets through replacements without reserving any input
    // character as a sentinel. Literal tildes and control characters stay literal.
    const replaceMatches = (source: string, matches: { start: number; end: number; sibling?: boolean; relative?: boolean }[], track: boolean): string => {
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
        if (track) next.set(length, match.sibling || match.relative ? "sibling" : "home");
        const root = match.sibling || match.relative ? "…/" : "~";
        parts.push(root); length += root.length;
        previous = match.end;
      }
      append(source.length);
      if (track) mappedRoots = next;
      return parts.join("");
    };
    // Match raw paths segment by segment, retaining source offsets. Separator
    // runs, dot segments and traversal do not alter a home's identity. Matching
    // at every stack suffix also covers homes inside longer absolute paths.
    const replaceCanonicalHomes = (source: string): string => {
      if (!canonical.length || !/[\\/]/.test(source)) return source;
      const stack: { text: string; start: number }[] = [];
      const matches: { start: number; end: number; sibling?: boolean; relative?: boolean }[] = [];
      const separators = [...source.matchAll(/[\\/]+/g)];
      let previous = 0;
      let pathRoot: number | undefined;
      let driveRoot: { start: number } | undefined;
      for (let i = 0; i < separators.length; i++) {
        const sep = separators[i]!, start = sep.index!, begin = start + sep[0].length;
        const end = separators[i + 1]?.index ?? source.length;
        const prefix = source.slice(Math.max(0, start - 16), start);
        if (pathStart(source, start) && !relativeRoot(source, start)) {
          pathRoot = start; driveRoot = undefined; stack.length = 0;
        }
        const drive = /(?:[\\/]{2}[?.][\\/])?([A-Za-z]):$/.exec(prefix);
        const aliasDrive = /(?<!:)[\\/](?:(?:cygdrive|mnt)[\\/])?([A-Za-z])$/.exec(prefix);
        const rootDrive = drive ?? (aliasDrive && pathStart(source, start - aliasDrive[0].length) ? aliasDrive : null);
        if (rootDrive) {
          pathRoot = start; driveRoot = { start: start - rootDrive[0].length }; stack.length = 0;
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
          let from = stack[offset]!.start;
          // One-segment homes identify only an effective root. Longer homes
          // keep the conservative mid-path rule, independent of drive identity.
          if (count === 1 && (offset !== 0 || pathRoot === undefined && !relativeRoot(source, from))) continue;
          if (candidate.drive) from = driveRoot?.start ?? (count === 1 ? pathRoot ?? from : from);
          else if (count === 1) from = pathRoot ?? from;
          const relative = relativeRoot(source, from);
          if (relative) from -= source[from - 2] === "." ? 2 : 1;
          if (from < previous) continue;
          // A file URL's third slash is its path root, not its sentinel.
          if (source[from - 1] === ":" && source.startsWith("///", from)) from += 2;
          if (source[from - 1] === "~") from--;
          // A glued sibling keeps its complete folder name, never the home's
          // parent segments. Only exact canonical segments earn a ~ root.
          previous = sibling ? begin : begin + consumed;
          matches.push({ start: from, end: previous, sibling, relative });
          break;
        }
      }
      return replaceMatches(source, matches, true);
    };
    // Protect homes BEFORE choosing suffixes. Otherwise a merged outside path
    // can discard the full home while retaining a private home segment.
    const replaceHomes = (result: string, beforePaths = false): string => {
      let search = searchable(result);
      for (const form of forms) {
        const matches: { start: number; end: number; relative?: boolean }[] = [];
        let previous = 0, pos = search.text.indexOf(form.folded);
        if (pos === -1) continue;
        do {
          const start = search.original(pos), end = search.original(pos + form.folded.length);
          const relative = relativeRoot(result, start);
          const from = relative ? start - (result[start - 2] === "." ? 2 : 1) : start;
          if ((!form.rootOnly || pathStart(result, from)) &&
            (!beforePaths || /%[0-9a-f]{2}|\+/i.test(form.text) || !/[\p{L}\p{N}\p{M}_-]/u.test(result[end] ?? ""))) {
            matches.push({ start: from > previous && result[from - 1] === "~" ? from - 1 : from, end, relative }); previous = end;
          }
          pos = search.text.indexOf(form.folded, pos + form.folded.length);
        } while (pos !== -1);
        if (previous) {
          result = replaceMatches(result, matches, beforePaths);
          search = searchable(result);
        }
      }
      return result;
    };
    value = replaceHomes(replaceCanonicalHomes(value), true).replace(/~\\/g, "~/");
    const finish = (result: string) => [...result].slice(0, 160).join("");
    if (pathValue && /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/]|\\\\)/.test(value) &&
      ![...mappedRoots.keys()].some(offset => offset > 0)) {
      return finish(replaceHomes(normalizedPathLabel(value, home)));
    }
    // KMP gives the longest home prefix at a string's end in linear time.
    const tailPrefix = (s: string, form: HomeForm): number => {
      let j = 0;
      for (let i = 0; i < s.length; i++) {
        while (j && (j === form.folded.length || s[i] !== form.folded[j])) j = form.failure[j - 1]!;
        if (s[i] === form.folded[j]) j++;
      }
      return j;
    };
    const search = searchable(value), folded = search.text;
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
      for (let pos = start; pos < i; pos++) if (separator(value[pos]!) || mappedRoots.has(pos)) lastSeparator = pos;
      runs.push({ start, end: i, lastSeparator, continuation: runs.length });
    }
    // A short two-component slash token cannot start a path or bridge by
    // itself. Within an already detected path it is ambiguous, so N2 applies.
    const abbreviation = (run: string) => /^(?:[A-Za-z0-9]{1,3}\/[A-Za-z0-9]{0,3})$/.test(run);
    // Reverse dynamic programming bridges separator-free words inside a path
    // segment. Explicit relative starts and terminal punctuation end a bridge.
    // Each gap is scanned once, including runs not consumed by redaction.
    let nextSeparator = runs.length - 1;
    for (let i = runs.length - 2; i >= 0; i--) {
      if (runs[i + 1]!.lastSeparator >= 0) nextSeparator = i + 1;
      const next = runs[nextSeparator]!;
      if (runs[i]!.lastSeparator < 0 || next.lastSeparator < 0) continue;
      const bareMappedHome = next.lastSeparator === next.start && mappedRoots.get(next.start) === "home";
      const newStart = bareMappedHome || /^(?:[\\/]|~[\\/]|[A-Za-z]:[\\/]|\.{1,2}[\\/])/.test(value.slice(next.start, next.end)) ||
        /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value.slice(next.start, next.end));
      if (runs[i]!.lastSeparator >= 0 && next.lastSeparator >= 0 && next.start < cutTail &&
        !/[,;]$/.test(value.slice(runs[i]!.start, runs[i]!.end)) &&
        !bareMappedHome && !/^\.{1,2}[\\/]/.test(value.slice(next.start, next.end)) &&
        (nextSeparator === i + 1 || !newStart)) runs[i]!.continuation = next.continuation;
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
              while (path < end && !separator(value[path]!) && !value.startsWith("~/", path)) path++;
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
        if (value.startsWith("\\\\", i) || value.startsWith("~/", i) || mappedRoots.has(i) && i <= lastSlash) return i;
        // Single-backslash roots are conservatively private too. Only relative
        // separators are exempt, not absolute starts glued after relative prose.
        if (separator(value[i]!) && i < lastSlash && (!relative || value[i] === "\\")) {
          const relativeSeparator = explicitlyRelative &&
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
      const path = firstPath(run.start, run.end, runs[last]!.lastSeparator);
      pieces.push(value.slice(previous, path < 0 ? run.end : path));
      if (path >= 0) {
        r = last;
        const bodyEnd = Math.min(end, cutTail);
        let rawBody = value.slice(path, bodyEnd);
        // A mapped home inside an outside path resets the presentation root.
        // No pre-home segment can become part of the visible suffix.
        let rootOffset = 0;
        for (const [offset] of mappedRoots) {
          if (offset >= path && offset < bodyEnd && (offset === path || !rawBody.startsWith("~/") ||
            /[\p{L}\p{N}\p{M}._~\/\\\s-]/u.test(value[offset - 1] ?? ""))) rootOffset = offset - path;
        }
        rawBody = rawBody.slice(rootOffset);
        const tildeBody = rawBody.startsWith("~/");
        const expandedHome = meaningfulHome(home) && tildeBody &&
          rawBody.split(/[\\/]+/).some(segment => segment === "." || segment === "..");
        if (expandedHome) rawBody = home + rawBody.slice(1);
        const root = /^(?:[~…][\\/]|[A-Za-z]:[\\/]+|[\\/]+)/.exec(rawBody)?.[0] ?? "";
        const rawSegments = rawBody.slice(root.length).split(/[\\/]+/).filter(Boolean);
        const segments: string[] = [];
        for (let segment of rawSegments) {
          const dot = /^\.{1,2}(?=\s|$)/.exec(segment)?.[0];
          if (dot) {
            if (dot === "..") segments.pop();
            segment = segment.slice(dot.length).trimStart();
          }
          if (segment) segments.push(segment);
        }
        // Keep unchanged spelling (including home forms and punctuation) unless
        // traversal needs normalization. Empty stacks clamp at the detected root.
        const body = rawSegments.some(segment => /^\.{1,2}(?:\s|$)/.test(segment)) ? root + segments.join("/") : rawBody;
        const bodySearch = searchable(body);
        const formOffset = body.startsWith("~") ? 1 : 0;
        const underHome = forms.find(form => bodySearch.text.startsWith(form.folded, formOffset) &&
          (body.length === bodySearch.original(formOffset + form.folded.length) || separator(body[bodySearch.original(formOffset + form.folded.length)]!)));
        const suffix = underHome ? body.slice(bodySearch.original(formOffset + underHome.folded.length)) : meaningfulHome(home) && body.startsWith("~/") ? body.slice(1) : undefined;
        // A single short home-relative path keeps its familiar label. Joined
        // paths consume one suffix, just like outside-home paths, rather than
        // passing a second absolute root through an initial home exemption.
        if (mappedRoots.get(path + rootOffset) === "home" && !/[\\/]/.test(body)) pieces.push(body);
        else if (suffix !== undefined && suffix.split(/[\\/]+/).filter(Boolean).length <= 2) pieces.push(body.replaceAll("\\", "/") + (tildeBody && suffix === "" ? "/" : ""));
        else pieces.push("…/" + (expandedHome ? outsideHomeTail(segments, home) : segments).slice(-2).join("/"));
        pieces.push(value.slice(bodyEnd, end));
      }
      previous = path < 0 ? run.end : end;
    }
    pieces.push(value.slice(previous));
    let result = pieces.join("");
    result = replaceHomes(result);
    if (cap < input.length) {
      const search = searchable(result);
      let length = 0;
      for (const form of forms) {
        const prefix = tailPrefix(search.text, form);
        if ((prefix >= 8 || prefix >= form.firstSegmentEnd) && prefix < form.folded.length) length = Math.max(length, result.length - search.original(search.text.length - prefix));
      }
      if (length) result = result.slice(0, -length) + "~…";
    }
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
