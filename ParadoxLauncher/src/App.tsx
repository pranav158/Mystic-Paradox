import { useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { PolicyProvider } from "./policy/PolicyContext";
import { LoginScreen } from "./screens/LoginScreen";
import { RegisterScreen } from "./screens/RegisterScreen";
import { SetUsernameScreen } from "./screens/SetUsernameScreen";
import { DashboardShell } from "./screens/DashboardShell";
import { Button } from "./components/Button";
import mysticLogo from "./assets/mystic_full.png";
import { checkLauncherUpdate, installLauncherUpdate, type LauncherUpdate } from "./api/updates";
import { sanitizeError } from "./lib/sanitize";

const DEV = import.meta.env.DEV;

function AppShell() {
  const { status, authError, retrySavedSession, forgetSavedSession } = useAuth();
  const [showRegister, setShowRegister] = useState(false);
  const [launcherUpdate, setLauncherUpdate] = useState<LauncherUpdate | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    // Check for a launcher self-update on app START, regardless of auth status. Previously this was
    // gated behind status === "signedIn", so a persistent/saved session (or a launcher that can't
    // reach the account server, or is stuck at login) would never self-update. The updater is
    // independent of login, so run it as soon as the app mounts.
    let cancelled = false;
    void checkLauncherUpdate()
      .then((update) => {
        if (!cancelled) {
          if (update) {
            if (DEV) console.log("[updater] new version available:", update.version);
            setLauncherUpdate(update);
          } else {
            if (DEV) console.log("[updater] already on latest");
          }
        }
      })
      .catch((err) => {
        if (DEV) console.warn("[updater] check failed:", err);
      });
    return () => { cancelled = true; };
  }, []);

  // Re-check every 30 min for long-running sessions (also independent of auth status).
  useEffect(() => {
    const interval = setInterval(() => {
      void checkLauncherUpdate()
        .then((update) => {
          if (update) {
            if (DEV) console.log("[updater] periodic check found new version:", update.version);
            setLauncherUpdate(update);
          }
        })
        .catch(() => {});
    }, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const updateBanner = launcherUpdate ? (
    <div className="fixed inset-x-5 top-5 z-50 mx-auto flex max-w-xl items-center justify-between gap-4 rounded-xl border border-accent/30 bg-surface/95 px-4 py-3 shadow-[0_16px_50px_-20px] shadow-black/70 backdrop-blur">
      <div className="min-w-0">
        <p className="text-[12px] font-semibold text-text">Mystic Paradox {launcherUpdate.version} is ready</p>
        <p className="mt-0.5 truncate text-[11px] text-text-muted">{updateError ?? "A new version is ready to install."}</p>
      </div>
      <Button
        disabled={installingUpdate}
        onClick={() => {
          setInstallingUpdate(true);
          setUpdateError(null);
          void installLauncherUpdate(launcherUpdate).catch((err) => {
            setInstallingUpdate(false);
            const message = sanitizeError(err instanceof Error ? err.message : String(err));
            if (DEV) console.error("[updater] install failed:", err);
            setUpdateError(message);
          });
        }}
      >
        {installingUpdate ? "Installing…" : "Update"}
      </Button>
    </div>
  ) : null;

  if (status === "checking") {
    return (
      <div className="relative flex h-full items-center justify-center overflow-hidden">
        <div className="aether-halo pointer-events-none absolute inset-0" />
        <div className="relative flex flex-col items-center">
          <img src={mysticLogo} alt="Mystic Development" className="h-24 w-24 object-contain drop-shadow-[0_0_18px_rgba(139,116,255,0.16)]" />
          <p className="mt-1 text-sm font-medium text-text">Mystic Paradox</p>
          <div className="mt-3 h-0.5 w-28 overflow-hidden rounded-full bg-border">
            <div className="h-full w-1/2 animate-[loading-slide_1.4s_ease-in-out_infinite] rounded-full bg-accent" />
          </div>
          <p className="mt-3 text-xs text-text-muted">Restoring your session…</p>
        </div>
      </div>
    );
  }

  if (status === "awaitingDiscord") {
    return (
      <div className="relative flex h-full items-center justify-center overflow-hidden px-6">
        <div className="aether-halo pointer-events-none absolute inset-0" />
        <div className="relative w-full max-w-sm rounded-2xl border border-border bg-surface/80 p-6 text-center shadow-[0_16px_48px_-16px] shadow-black/60">
          <p className="text-sm font-medium text-text">Waiting for Discord…</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-text-muted">
            Complete sign-in in the browser window that just opened.
          </p>
        </div>
      </div>
    );
  }

  if (status === "restoreFailed") {
    return (
      <>{updateBanner}
      <div className="relative flex h-full items-center justify-center overflow-hidden px-6">
        <div className="aether-halo pointer-events-none absolute inset-0" />
        <div className="relative w-full max-w-sm rounded-2xl border border-border bg-surface/90 p-6 text-center shadow-[0_16px_48px_-16px] shadow-black/60">
          <img src={mysticLogo} alt="Mystic Development" className="mx-auto h-24 w-24 object-contain drop-shadow-[0_0_18px_rgba(139,116,255,0.16)]" />
          <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-text-faint">By Mystic Development</p>
          <h1 className="mt-4 text-lg font-semibold text-text">Your session is still saved</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-text-muted">
            {authError ?? "The launcher couldn't contact the account server yet."}
          </p>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <Button onClick={() => void retrySavedSession()}>Retry</Button>
            <Button variant="secondary" onClick={() => void forgetSavedSession()}>Sign in again</Button>
          </div>
        </div>
      </div>
      </>
    );
  }

  if (status === "awaitingUsername") {
    return <SetUsernameScreen />;
  }

  if (status === "pendingApproval") {
    return (
      <>{updateBanner}
      <div className="relative flex h-full items-center justify-center overflow-hidden px-6">
        <div className="aether-halo pointer-events-none absolute inset-0" />
        <div className="relative w-full max-w-sm rounded-2xl border border-border bg-surface/90 p-7 text-center shadow-[0_16px_48px_-16px] shadow-black/60">
          <img src={mysticLogo} alt="Mystic Development" className="mx-auto h-24 w-24 object-contain" />
          <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.22em] text-accent-hover">Closed testing</p>
          <h1 className="mt-2 text-xl font-semibold text-text">Request received</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-text-muted">
            Your username is reserved. An administrator must approve the account before it can sign in or launch Dauntless.
          </p>
          <Button className="mt-6 w-full" variant="secondary" onClick={() => void forgetSavedSession()}>
            Back to sign in
          </Button>
        </div>
      </div>
      </>
    );
  }

  if (status === "signedIn") {
    return <>{updateBanner}<DashboardShell /></>;
  }

  return showRegister ? (
    <>{updateBanner}<RegisterScreen onBackToLogin={() => setShowRegister(false)} /></>
  ) : (
    <>{updateBanner}<LoginScreen onCreateAccount={() => setShowRegister(true)} /></>
  );
}

export default function App() {
  return (
    <div className="h-full bg-bg">
      <AuthProvider>
        <PolicyProvider>
          <AppShell />
        </PolicyProvider>
      </AuthProvider>
    </div>
  );
}
