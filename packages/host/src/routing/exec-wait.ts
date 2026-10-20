import { isForegroundWait } from "./sleep-wait";

function hasDelay(code: string, pattern: RegExp, minimum: number): boolean {
  return [...code.matchAll(pattern)].some(match => Number(match[1]) >= minimum);
}

// Bound the timer search to the awaited Promise, rather than a later,
// unrelated timer. This is still a heuristic, not a JavaScript parser.
function awaitedPromiseBodies(code: string): string[] {
  const bodies: string[] = [];
  for (const match of code.matchAll(/\bawait\s+new\s+Promise(?:<[^>]*>)?\s*\(/g)) {
    const start = match.index + match[0].length;
    let depth = 1;
    for (let i = start; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")" && --depth === 0) {
        bodies.push(code.slice(start, i));
        break;
      }
    }
  }
  return bodies;
}

/** Extra spider rules; keep the upstream shell classifier unchanged. */
export function isExecWait(language: unknown, code: unknown): boolean {
  if (typeof code !== "string") return false;
  switch (language) {
    case "shell":
      return isForegroundWait(code) ||
        /\bgh\s+run\s+watch\b/.test(code) ||
        /\btail\b[^\n;|&]*\s(?:-[a-zA-Z]*f[a-zA-Z]*\b|--follow\b)/.test(code) ||
        hasDelay(code, /\bread\b[^\n;|&]*?\s-t\s*(\d+(?:\.\d+)?)\b/g, 2) ||
        /\b(?:while|until)\b(?:(?!\bdone\b)[\s\S])*?\bdo\b(?:(?!\bdone\b)[\s\S])*?\bsleep\b/.test(code);
    case "python":
      return hasDelay(code, /\btime\s*\.\s*sleep\s*\(\s*(\d+(?:\.\d+)?)\s*\)/g, 2);
    case "javascript":
    case "typescript":
      return hasDelay(code, /\bawait\s+(?:[\w$]+\.)?setTimeout\s*\(\s*(\d+(?:\.\d+)?)\s*[,)]/g, 2000) ||
        awaitedPromiseBodies(code).some(body =>
          hasDelay(body, /\bsetTimeout\s*\([\s\S]*?,\s*(\d+(?:\.\d+)?)\s*[,)]/g, 2000));
    case "ruby":
    case "perl":
      return hasDelay(code, /\bsleep(?:\s*\(\s*|\s+)(\d+(?:\.\d+)?)\b/g, 2);
    default:
      return false;
  }
}
