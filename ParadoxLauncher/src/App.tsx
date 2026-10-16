import { useEffect, useState, type ReactNode } from "react";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { AccountRulesProvider, useAccountRules } from "./auth/AccountRules";
import { PolicyProvider } from "./policy/PolicyContext";
import { ServerProvider, useServer } from "./servers/ServerContext";
import { RealmTrustProvider } from "./servers/RealmTrust";
import { LoginScreen } from "./screens/LoginScreen";
import { RegisterScreen } from "./screens/RegisterScreen";
import { EmailCodeScreen } from "./screens/EmailCodeScreen";
import { PasswordResetScreen } from "./screens/PasswordResetScreen";
import { SetUsernameScreen } from "./screens/SetUsernameScreen";
import { ConsentScreen, ConsentUnavailableScreen } from "./screens/ConsentScreen";
import { DashboardShell } from "./screens/DashboardShell";
import { Button } from "./components/Button";
import { TitleBar } from "./components/TitleBar";
import { AuthCard, AuthLayout } from "./components/AuthLayout";
import { AetherMark } from "./components/AetherMark";
import { SparkIcon } from "./components/icons";
import { checkLauncherUpdate, installLauncherUpdate, launcherUpdateHoldReason, type LauncherUpdate } from "./api/updates";
import { startPublicBuildCheckAtStartup } from "./components/PublicBuildCheck";
import { sanitizeError } from "./lib/sanitize";
import { NoticesProvider } from "./notices/NoticesContext";

const DEV = import.meta.env.DEV;

/** [2026-10-15] How often the update toast asks whether the update must still wait (a game, or hosting). */
const UPDATE_HOLD_POLL_MS = 5000;

function UpdateToast({ update }: { update: LauncherUpdate }) {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // [2026-10-15] Never mid-hunt: while a game runs or this PC hosts, the update waits and says why.
  const [hold, setHold] = useState<string | null>(null);
  const notes = update.body?.trim().split("\n")[0]?.slice(0, 160);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      void launcherUpdateHoldReason()
        .then((reason) => {
          if (!cancelled) setHold(reason);
        })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, UPDATE_HOLD_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="glass glass-strong toast" role="status">
      <div className="toast-icon"><SparkIcon /></div>
      <div className="toast-copy">
        <p className="toast-title">Launcher {update.version} is ready</p>
        <p className="toast-body">{error ?? hold ?? notes ?? "Security and compatibility updates are ready to install."}</p>
      </div>
      <Button
        size="sm"
        loading={installing}
        loadingLabel="Installing…"
        disabled={hold !== null}
        onClick={() => {
          setInstalling(true);
          setError(null);
          // Asked once more right before installing: a game may have started since the last poll.
          void launcherUpdateHoldReason()
            .catch(() => null)
            .then((reason) => {
              if (reason) {
                setHold(reason);
                setInstalling(false);
                return;
              }
              return installLauncherUpdate(update);
            })
            .catch((err) => {
              setInstalling(false);
              if (DEV) console.error("[updater] install failed:", err);
              setError(sanitizeError(err instanceof Error ? err.message : String(err)));
            });
        }}
      >
        {hold ? "Waiting" : "Update now"}
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

// [2026-10-13 realms S5] A local server is selected and its warning has not been accepted: nothing is sent to it. The
// warning popup opens on its own; this screen is what stays behind it after a Cancel.
function ServerConsentScreen() {
  const { selected, select, openWarning } = useServer();
  const [error, setError] = useState<string | null>(null);
  return (
    <StatusScreen title="Local server">
      <p className="auth-sub">
        {selected?.name ?? "This server"} is a local server. Nothing is sent to it until you have read and accepted its warning.
      </p>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="status-actions">
        <Button onClick={() => selected && openWarning(selected.id)}>Read the warning</Button>
        <Button
          variant="secondary"
          onClick={() => {
            setError(null);
            select("official").catch((err) => setError(typeof err === "string" ? err : "Couldn't switch servers."));
          }}
        >
          Use the official server
        </Button>
      </div>
    </StatusScreen>
  );
}

function AppShell() {
  const { status, account, authError, retrySavedSession, forgetSavedSession, backToSignIn } = useAuth();
  // [2026-10-14] Terms of Use and Privacy Policy: a Mystic Paradox account must accept the current ones before the dashboard.
  const rules = useAccountRules();
  const [showRegister, setShowRegister] = useState(false);
  // [2026-10-16] The sign-up form is a choice made while signed out. Once a registration has moved on (the code screen, the
  // approval wait, signed in), "Back to sign in" and any later sign-out return to the sign-in card, not to the sign-up form.
  useEffect(() => {
    if (status !== "signedOut") setShowRegister(false);
  }, [status]);
  const [launcherUpdate, setLauncherUpdate] = useState<LauncherUpdate | null>(null);
  const { selected, officialNetwork } = useServer();

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

  // [2026-10-15] The GitHub build check runs once at startup, in the background; About shows its cached result.
  useEffect(() => {
    startPublicBuildCheckAtStartup();
  }, []);

  const toast = launcherUpdate ? <UpdateToast update={launcherUpdate} /> : null;

  let screen;
  if (status === "needsServerConsent") {
    screen = <ServerConsentScreen />;
  } else if (status === "checking") {
    screen = (
      <StatusScreen title="Restoring your session" busy>
        <p className="auth-sub">{officialNetwork ? "Contacting the Mystic Paradox account server…" : `Contacting ${selected?.name ?? "the server"}…`}</p>
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
        <p className="auth-sub">{authError ?? (officialNetwork ? "The launcher couldn't contact the account server yet." : `The launcher couldn't contact ${selected?.name ?? "the server"} yet.`)}</p>
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
          {/* [2026-10-16] Since 0.1.71 the name is chosen at sign-up: only an account that still has none is told to choose it. */}
          {officialNetwork
            ? `Your account is waiting for an administrator's approval. Once it is approved, sign in to play${account?.needsUsername ? " and choose your username" : ""}.`
            : `Your username is reserved. The host of ${selected?.name ?? "this server"} may need to approve new accounts; once yours is approved, sign in to play.`}
        </p>
        <div className="status-actions single">
          <Button block variant="secondary" onClick={() => void forgetSavedSession()}>Back to sign in</Button>
        </div>
      </StatusScreen>
    );
  } else if (status === "awaitingEmailCode") {
    // [2026-10-15] A code was emailed (sign-up, or an unverified sign-in). Back goes to the sign-in card, not sign-up.
    screen = <EmailCodeScreen onBack={() => { setShowRegister(false); backToSignIn(); }} />;
  } else if (status === "passwordReset") {
    screen = <PasswordResetScreen />;
  } else if (status === "signedIn" && rules.gate === "checking") {
    screen = (
      <StatusScreen title="Checking your account" busy>
        <p className="auth-sub">Reading the Terms of Use status of your account…</p>
      </StatusScreen>
    );
  } else if (status === "signedIn" && rules.gate === "failed") {
    screen = <ConsentUnavailableScreen />;
  } else if (status === "signedIn" && rules.gate === "accept") {
    screen = <ConsentScreen />;
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
    // [2026-10-15] The launcher notices (banner and tags) are fetched once for the whole app, signed out or in.
    <NoticesProvider>
      <ServerProvider>
        {/* [2026-10-14 realms] The realm host confirmation, its ownership warning and the realm notices (under ServerProvider). */}
        <RealmTrustProvider>
          <AuthProvider>
            <AccountRulesProvider>
              <PolicyProvider>
                <AppShell />
                <TitleBar />
              </PolicyProvider>
            </AccountRulesProvider>
          </AuthProvider>
        </RealmTrustProvider>
      </ServerProvider>
    </NoticesProvider>
  );
}
