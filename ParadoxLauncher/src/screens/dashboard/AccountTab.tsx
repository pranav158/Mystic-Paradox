import { useAuth } from "../../auth/AuthContext";
import { Button } from "../../components/Button";

export function AccountTab() {
  const { account, logout } = useAuth();

  return (
    <div className="max-w-lg px-8 py-7">
      <h1 className="text-xl font-semibold tracking-tight text-text">Account</h1>
      <p className="mt-1 text-[13px] text-text-muted">Your Slayer identity across launcher and game.</p>

      <div className="mt-7 overflow-hidden rounded-2xl border border-border bg-surface">
        <div className="flex items-center gap-4 p-6">
          <div className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-accent-muted text-lg font-semibold text-accent-hover">
            {(account?.displayName ?? "?").slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-medium text-text">{account?.displayName}</p>
            <p className="truncate text-[13px] text-text-muted">{account?.email}</p>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-border px-6 py-4">
          <div>
            <p className="text-[13px] font-medium text-text">Discord</p>
            <p className="mt-0.5 text-xs text-text-muted">
              {account?.discordLinked ? "Linked — sign in with either method" : "Not linked"}
            </p>
          </div>
          <Button variant="secondary" className="w-auto px-4" disabled title="Discord linking isn't wired up yet">
            {account?.discordLinked ? "Unlink" : "Link Discord"}
          </Button>
        </div>
      </div>

      <Button variant="secondary" className="mt-6 w-full" onClick={() => void logout()}>
        Log out
      </Button>
    </div>
  );
}
