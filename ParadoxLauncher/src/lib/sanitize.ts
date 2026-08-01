const LEAK_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /https?:\/\/[^\s]+/gi, replacement: "the update server" },
  { pattern: /\b[A-Z]:\\[^\s,]+/g, replacement: "a game file" },
  { pattern: /\(os error \d+\)/gi, replacement: "" },
  { pattern: /error sending request for url/gi, replacement: "" },
  { pattern: /CreateProcess error \d+/gi, replacement: "an error" },
  { pattern: /\bdns error\b/gi, replacement: "a network error" },
  { pattern: /\bconnection refused\b/gi, replacement: "a connection issue" },
  { pattern: /\bconnection reset\b/gi, replacement: "a connection issue" },
  { pattern: /\bno route to host\b/gi, replacement: "a connection issue" },
  { pattern: /\bconnect ETIMEDOUT\b/gi, replacement: "a connection timeout" },
  { pattern: /\btls handshake.*failed\b/gi, replacement: "a secure connection issue" },
  { pattern: /Couldn't read [^\s:]+:/gi, replacement: "Couldn't read" },
  { pattern: /Couldn't (create|download|check|stage|install|read|prepare|back up) [^:]+:/gi, replacement: "Couldn't update" },
  { pattern: /Runtime (download|update server) returned \d+/gi, replacement: "The update server is unavailable" },
  { pattern: /^\s*(?:error|warning|info)\s*[:\-]\s*/gi, replacement: "" },
];

export function sanitizeError(raw: string | null | undefined): string {
  if (!raw || raw.trim().length === 0) {
    return "Something went wrong. Please try again.";
  }

  let cleaned = raw.trim();

  for (const { pattern, replacement } of LEAK_PATTERNS) {
    cleaned = cleaned.replace(pattern, replacement);
  }

  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();

  if (cleaned.length === 0 || cleaned === ":" || cleaned === "-") {
    return "Something went wrong. Please try again.";
  }

  return cleaned;
}
