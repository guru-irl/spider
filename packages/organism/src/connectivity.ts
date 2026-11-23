const NETWORK_CODES = new Set([
  "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETDOWN", "ENETUNREACH",
  "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

/** Classify errors from the provider call, not the content returned by it. */
export function isConnectivityFailure(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  let connectivity = false;
  for (let depth = 0; depth < 8 && current != null; depth++) {
    if (typeof current === "object") {
      if (seen.has(current)) break;
      seen.add(current);
      const value = current as { code?: unknown; name?: unknown; message?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };
      if (value.name === "OrganismDeadline") return false;
      const status = typeof value.status === "number" ? value.status : value.statusCode;
      if (typeof status === "number" && status >= 400 && status < 500 && status !== 408) return false;
      const code = typeof value.code === "string" ? value.code.toUpperCase() : "";
      if (["UNAUTHORIZED", "FORBIDDEN", "AUTHENTICATION_ERROR", "INVALID_API_KEY", "PERMISSION_DENIED"].includes(code)) return false;
      if (typeof value.message === "string" && identityMessage(value.message)) return false;
      if (NETWORK_CODES.has(code) || value.name === "TimeoutError" || value.name === "AbortError" || status === 408 || status === 502 || status === 503 || status === 504 || typeof value.message === "string" && connectivityMessage(value.message)) connectivity = true;
      current = value.cause;
    } else {
      if (typeof current === "string") {
        if (identityMessage(current)) return false;
        connectivity ||= connectivityMessage(current);
      }
      break;
    }
  }
  return connectivity;
}

function identityMessage(message: string): boolean {
  return /\b(?:unauthori[sz]ed|forbidden|(?:authentication|authori[sz]ation) (?:failed|required|failure)|invalid (?:api[_ -]?key|credentials?)|credentials? (?:invalid|expired)|access denied|permission denied)\b/i.test(message);
}

function connectivityMessage(message: string): boolean {
  return /\b(?:offline|fetch failed|network (?:error|failed|unreachable)|socket hang up|connection (?:refused|reset|closed|lost|timed out)|(?:host|provider|service) (?:temporarily )?(?:unreachable|unavailable)|timed out|timeout|econnrefused|econnreset|ehostunreach|enetunreach|enotfound|eai_again|etimedout)\b/i.test(message);
}
