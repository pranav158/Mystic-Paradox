const STORAGE_KEY = "mysticparadox.deviceId";

/** A locally generated, persistent identifier sent with login/register — not a secret. */
export function getDeviceId(): string {
  const existing = localStorage.getItem(STORAGE_KEY);

  if (existing) {
    return existing;
  }

  const generated = crypto.randomUUID();
  localStorage.setItem(STORAGE_KEY, generated);

  return generated;
}
