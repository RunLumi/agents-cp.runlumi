import { useState } from "react";
import { LumiWordmark } from "@/components/brand";
import { approveDesktopSignIn, type MeResponse } from "@/lib/api";
import { presentApiError } from "@/lib/errors";

export function DesktopApproval({ me, onSignOut }: { me: MeResponse; onSignOut: () => void }) {
  const [code, setCode] = useState(
    () => new URLSearchParams(window.location.search).get("user_code") ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function approve(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !/^[A-Z0-9]{8}$/.test(code)) return;
    setBusy(true);
    setError(null);
    try {
      await approveDesktopSignIn(code);
      setApproved(true);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--surface)] px-4 text-[var(--foreground)]">
      <section className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--panel)] p-6 shadow-[var(--shadow)]">
        <LumiWordmark className="mb-6 h-7" />
        <h1 className="text-xl font-semibold">Sign in to Lumi Agents Desktop</h1>
        <p className="mt-3 text-sm text-[var(--muted-strong)]">Account: {me.user.email}</p>
        {approved ? (
          <div role="status" className="mt-6">
            <p>Desktop sign-in approved.</p>
            <p className="mt-2 text-sm">
              Return to the app and complete sign-in. Your local workspaces remain local until you
              explicitly bind them.
            </p>
          </div>
        ) : (
          <form onSubmit={(event) => void approve(event)} className="mt-6 space-y-4">
            <p className="text-sm leading-6">
              Approve only if you started sign-in in your desktop app and this code matches. This
              grants a Lumi account session; it does not enroll a device or adopt a workspace.
            </p>
            <label className="block text-sm" htmlFor="desktop-code">
              Code shown in your app
            </label>
            <input
              id="desktop-code"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              autoComplete="off"
              maxLength={8}
              pattern="[A-Z0-9]{8}"
              required
              disabled={busy}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono focus-visible:outline-2 focus-visible:outline-offset-2"
            />
            {error ? (
              <p role="alert" className="text-sm">
                {presentApiError(error).message}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={busy || !/^[A-Z0-9]{8}$/.test(code)}
              className="w-full rounded-md bg-[var(--civic-navy)] px-4 py-2 text-white disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {busy ? "Approving…" : "Approve desktop sign-in"}
            </button>
            <a href="/" className="block text-center text-sm underline">
              Cancel and return to Lumi
            </a>
          </form>
        )}
        <button
          type="button"
          onClick={onSignOut}
          disabled={busy}
          className="mt-6 text-sm underline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Use another account
        </button>
      </section>
    </main>
  );
}
