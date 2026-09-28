/**
 * The email-verification step, as a component in its own right.
 *
 * WHY IT IS EXTRACTED
 *
 * Found by V00-2026-09-27. The auth screen used to render the one-time code
 * input with no form and no submit control anywhere, so the code could not be
 * sent: `verifyEmail()` was exported from `lib/api.ts` and called from nowhere.
 * A user who signed up therefore could not set `email_verified`, and because
 * `Permission::requires_verified_email()` refuses every mutating permission,
 * the first thing they tried — creating an organization — was refused with
 * 403 `email_verification_required`, forever.
 *
 * The defect was the absence of behaviour, and absence is what a test cannot
 * see. The reason it was invisible for so long is that the step lived as
 * anonymous JSX inside a large `useState` machine, where no test could reach it
 * and no test could fail. Extracting it makes the surface renderable on its own,
 * so "there is a submit control" is an assertion a test can actually make.
 *
 * Exported for exactly that reason. Do not fold it back into the screen.
 */

import { useId } from "react";

import type { ErrorPresentation } from "@/lib/errors";

export interface EmailVerificationFormProps {
  /** The address the code was sent to. Shown so the user can check it. */
  email: string;
  code: string;
  busy: boolean;
  /** Present only in development builds; never shown in production. */
  developmentCode: string | null;
  error: ErrorPresentation | null;
  onCodeChange: (value: string) => void;
  onSubmit: () => void;
  onSkip: () => void;
}

export function EmailVerificationForm({
  email,
  code,
  busy,
  developmentCode,
  error,
  onCodeChange,
  onSubmit,
  onSkip,
}: EmailVerificationFormProps) {
  const codeId = useId();
  // The server's codes are longer than the minimum below; the length is only a
  // guard against submitting an empty field, not a validation of the code.
  const submittable = code.trim().length >= 6;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="space-y-4"
    >
      <p className="text-sm text-[var(--muted-strong)]">
        Verify {email || "your email address"} to finish setting up your account. Until it is
        verified, you can sign in but not create an organization or change settings.
      </p>
      {developmentCode ? (
        <div className="rounded-lg border border-[var(--lumi-blue)]/30 bg-[var(--lumi-blue-soft)] p-3 text-sm text-[var(--civic-navy)]">
          <p className="font-medium">Development verification code</p>
          <code className="mt-1 block break-all text-xs">{developmentCode}</code>
        </div>
      ) : null}
      <div>
        <label
          htmlFor={codeId}
          className="mb-1.5 block text-sm font-medium text-[var(--civic-navy)]"
        >
          One-time code
        </label>
        <input
          id={codeId}
          name="one-time-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          maxLength={64}
          value={code}
          onChange={(event) => onCodeChange(event.target.value)}
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          placeholder="Enter the code from your email"
        />
      </div>
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/5 p-3 text-sm text-[var(--danger)]"
        >
          {error.message}
          {error.requestId ? (
            <span className="mt-1 block text-xs opacity-75">Request {error.requestId}</span>
          ) : null}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy || !submittable}
        className="min-h-11 w-full rounded-lg bg-[var(--lumi-blue)] px-4 text-sm font-semibold text-white outline-none transition hover:bg-[var(--lumi-blue-hover)] focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "Verifying…" : "Verify email and continue"}
      </button>
      {/*
        Skipping is allowed and honest — F01-002 permits a session before
        verification. It is a secondary action, not the primary one, because the
        primary outcome of skipping is that every mutating action is refused.
      */}
      <button
        type="button"
        onClick={onSkip}
        className="min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 text-sm font-medium text-[var(--civic-navy)] outline-none transition hover:bg-[var(--panel-hover)] focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2"
      >
        Skip for now
      </button>
    </form>
  );
}
