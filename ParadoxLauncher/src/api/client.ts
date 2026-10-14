import type { LauncherErrorCode } from "./types";

// [2026-10-13 realms S5] The WebView no longer talks to any backend. Every account, policy, status and username call
// goes through the launcher's native side, which sends it to the SELECTED server's backend (the official one, or a
// local server's own) and keeps each server's tokens apart. This file keeps only the error type the UI shares.
export class LauncherApiError extends Error {
  code: LauncherErrorCode;
  requestId?: string;

  constructor(code: LauncherErrorCode, message: string, requestId?: string) {
    super(message);
    this.name = "LauncherApiError";
    this.code = code;
    this.requestId = requestId;
  }
}
