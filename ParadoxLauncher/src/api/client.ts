import type { LauncherErrorCode, ServerStatusResponse, UsernameAvailabilityResponse } from "./types";

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

// Configurable so pointing the launcher at another backend is a config change, not a code
// change. Without VITE_API_BASE_URL the fallback matches Rust's api_base_url(): the local dev
// port in development builds and the production service otherwise.
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? "http://127.0.0.1:3000" : "https://paradox.mysticfox.dev");

interface ErrorBody {
  error?: {
    code?: LauncherErrorCode;
    message?: string;
    requestId?: string;
  };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  } catch {
    // Network-level failure (server down, no connection, CORS rejection, etc.) —
    // client-synthesized, the server never sends this code itself.
    throw new LauncherApiError("SERVER_UNAVAILABLE", "Can't reach the Mystic Paradox server right now.");
  }

  let body: unknown = null;

  try {
    body = await response.json();
  } catch {
    // No/invalid JSON body — fall through with body left as null.
  }

  if (!response.ok) {
    const errorBody = (body ?? {}) as ErrorBody;
    throw new LauncherApiError(
      errorBody.error?.code ?? "UNKNOWN",
      errorBody.error?.message ?? "Something went wrong.",
      errorBody.error?.requestId,
    );
  }

  return body as T;
}

export const launcherApi = {
  checkUsername(name: string) {
    return request<UsernameAvailabilityResponse>(
      `/launcher/v1/username?name=${encodeURIComponent(name)}`,
      { method: "GET" },
    );
  },

  status() {
    return request<ServerStatusResponse>("/launcher/v1/status", { method: "GET" });
  },
};
