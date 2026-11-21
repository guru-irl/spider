const NETWORK_CODES = new Set([
  "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETDOWN", "ENETUNREACH",
  "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

/** Classify errors from the provider call, not the content returned by it. */
export function isConnectivityFailure(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 8 && current != null; depth++) {
    if (typeof current === "object") {
      if (seen.has(current)) break;
      seen.add(current);
      const value = current as { code?: unknown; name?: unknown; message?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };
      const status = typeof value.status === "number" ? value.status : value.statusCode;
      if (typeof status === "number" && status >= 400 && status < 500 && status !== 408) return false;
      if (typeof value.code === "string" && NETWORK_CODES.has(value.code.toUpperCase())) return true;
      if (value.name === "TimeoutError" || value.name === "AbortError") return true;
      if (status === 408 || status === 502 || status === 503 || status === 504) return true;
      if (typeof value.message === "string" && connectivityMessage(value.message)) return true;
      current = value.cause;
    } else {
      return typeof current === "string" && connectivityMessage(current);
    }
  }
  return false;
}

function connectivityMessage(message: string): boolean {
  return /\b(?:offline|fetch failed|network (?:error|failed|unreachable)|socket hang up|connection (?:refused|reset|closed|lost|timed out)|(?:host|provider|service) unreachable|timed out|timeout|econnrefused|econnreset|ehostunreach|enetunreach|enotfound|eai_again|etimedout)\b/i.test(message);
}
