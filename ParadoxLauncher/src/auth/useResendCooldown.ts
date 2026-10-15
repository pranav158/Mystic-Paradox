import { useCallback, useEffect, useState } from "react";

/** [2026-10-15] A new code can be asked for once a minute. */
export const RESEND_COOLDOWN_SECONDS = 60;

/**
 * The "Resend code" cooldown. `remaining` is the seconds left (0: a new code can be asked for) and `start()` begins the
 * wait after each send. `startsCooling`: the code was sent before the screen opened (a sign-up or an unverified sign-in).
 */
export function useResendCooldown(startsCooling = false): { remaining: number; start: () => void } {
  const [remaining, setRemaining] = useState(startsCooling ? RESEND_COOLDOWN_SECONDS : 0);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setRemaining((seconds) => seconds - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining]);

  const start = useCallback(() => setRemaining(RESEND_COOLDOWN_SECONDS), []);
  return { remaining, start };
}
