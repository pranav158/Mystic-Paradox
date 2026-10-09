import { useEffect, useState, type ReactNode } from "react";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { PolicyProvider } from "./policy/PolicyContext";
import { LoginScreen } from "./screens/LoginScreen";
import { RegisterScreen } from "./screens/RegisterScreen";
import { SetUsernameScreen } from "./screens/SetUsernameScreen";
import { DashboardShell } from "./screens/DashboardShell";
import { Button } from "./components/Button";
import { TitleBar } from "./components/TitleBar";
import { AuthCard, AuthLayout } from "./components/AuthLayout";
import { AetherMark } from "./components/AetherMark";
import { SparkIcon } from "./components/icons";
import { checkLauncherUpdate, installLauncherUpdate, type LauncherUpdate } from "./api/updates";
import { sanitizeError } from "./lib/sanitize";

const DEV = import.meta.env.DEV;

function UpdateToast({ update }: { update: LauncherUpdate }) {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notes = update.body?.trim().split("\n")[0]?.slice(0, 160);

  return (
    <div className="glass glass-strong toast" role="status">
      <div className="toast-icon"><SparkIcon /></div>
      <div className="toast-copy">
        <p className="toast-title">Launcher {update.version} is ready</p>
        <p className="toast-body">{error ?? notes ?? "Security and compatibility updates are ready to install."}</p>
      </div>
      <Button
        size="sm"
        loading={installing}
        loadingLabel="Installing…"
        onClick={() => {
          setInstalling(true);
          setError(null);
          void installLauncherUpdate(update).catch((err) => {
            setInstalling(false);
            if (DEV) console.error("[updater] install failed:", err);
            setError(sanitizeError(err instanceof Error ? err.message : String(err)));
          });
        }}
      >
        Update now
      </Button>
    </div>
  );
}

function StatusScreen({ title, children, busy = false }: { title: string; children?: ReactNode; busy?: boolean }) {
  return (
    <AuthLayout>
      <AuthCard title={title} className="status-card" icon={<div className="status-mark"><AetherMark title={null} /></div>}>
        {children}
        {busy && <div className="loader-bar" role="progressbar" aria-label={title} />}
      </AuthCard>
    </AuthLayout>
  );
}

function AppShell() {
  const { status, authError, retrySavedSession, forgetSavedSession } = useAuth();
  const [showRegister, setShowRegister] = useState(false);
  const [launcherUpdate, setLauncherUpdate] = useState<LauncherUpdate | null>(null);

  useEffect(() => {
    // Check for a launcher self-update on app start, whatever the auth state, then every 30 minutes.
    let cancelled = false;
    const check = () => {
      void checkLauncherUpdate()
        .then((update) => {
          if (cancelled || !update) return;
          if (DEV) console.log("[updater] new version available:", update.version);
          setLauncherUpdate(update);
        })
        .catch((err) => {
          if (DEV) console.warn("[updater] check failed:", err);
        });
    };
    check();
    const interval = setInterval(check, 30 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const toast = launcherUpdate ? <UpdateToast update={launcherUpdate} /> : null;

  let screen;
  if (status === "checking") {
    screen = (
      <StatusScreen title="Restoring your session" busy>
        <p className="auth-sub">Contacting the Mystic Paradox account server…</p>
      </StatusScreen>
    );
  } else if (status === "awaitingDiscord") {
    screen = (
      <StatusScreen title="Waiting for Discord" busy>
        <p className="auth-sub">Finish signing in in the browser window that just opened.</p>
      </StatusScreen>
    );
  } else if (status === "restoreFailed") {
    screen = (
      <StatusScreen title="Your session is still saved">
        <p className="auth-sub">{authError ?? "The launcher couldn't contact the account server yet."}</p>
        <div className="status-actions">
          <Button onClick={() => void retrySavedSession()}>Retry</Button>
          <Button variant="secondary" onClick={() => void forgetSavedSession()}>Sign in again</Button>
        </div>
      </StatusScreen>
    );
  } else if (status === "awaitingUsername") {
    screen = <SetUsernameScreen />;
  } else if (status === "pendingApproval") {
    screen = (
      <StatusScreen title="Request received">
        <p className="auth-sub">
          Your username is reserved. An administrator approves closed-test accounts; once yours is approved, sign in to play.
        </p>
        <div className="status-actions single">
          <Button block variant="secondary" onClick={() => void forgetSavedSession()}>Back to sign in</Button>
        </div>
      </StatusScreen>
    );
  } else if (status === "signedIn") {
    screen = <DashboardShell />;
  } else {
    screen = showRegister
      ? <RegisterScreen onBackToLogin={() => setShowRegister(false)} />
      : <LoginScreen onCreateAccount={() => setShowRegister(true)} />;
  }

  return (
    <>
      {screen}
      {toast}
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <PolicyProvider>
        <AppShell />
        <TitleBar />
      </PolicyProvider>
    </AuthProvider>
  );
}
