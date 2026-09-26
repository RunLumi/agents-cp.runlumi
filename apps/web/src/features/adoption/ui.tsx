/**
 * Adoption surface primitives.
 *
 * Local to `features/adoption/**`, matching the other P0x feature primitives:
 * this repository does not generate a shared component library, and `@/components`
 * is outside this packet's write surface. Every value here is a token from
 * `src/styles/globals.css` — no palette, typeface, radius, or decorative style is
 * introduced — and the density is the same quiet, high-information admin idiom the
 * other surfaces use.
 *
 * The one component that is genuinely adoption-specific is `StageLadder`, and it
 * exists because the stage order IS the product. Rendering the six stages as a
 * vertical ladder with the reached rungs filled is what makes "you are two steps
 * in, and both of them were yours to take" legible at a glance; a status column
 * would throw that away.
 */

import type { ReactNode } from "react";

import { presentApiError } from "@/lib/errors";

import type { StageStep } from "./helpers";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export function Surface({
  children,
  ariaLabel,
  className,
}: {
  children: ReactNode;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <section
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
      className={[
        "overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-[var(--shadow)]",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </section>
  );
}

export function SurfaceHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-[var(--border)] px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h2 className="text-base font-semibold text-[var(--civic-navy)]">{title}</h2>
        {description ? (
          <p className="mt-1 max-w-3xl text-sm leading-5 text-[var(--muted-strong)]">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function LoadingRows({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <div className="p-5" role="status" aria-live="polite" aria-busy="true">
      <p className="text-sm text-[var(--muted-strong)]">{label}</p>
      <div className="mt-4 space-y-2" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="h-12 animate-pulse rounded-lg bg-[var(--panel-hover)]" />
        ))}
      </div>
    </div>
  );
}

/**
 * The shared error surface.
 *
 * `presentApiError` maps the stable reason code to frozen copy; the server's own
 * message is never rendered. The code and the request id are shown so a support
 * question is actionable.
 */
export function ErrorNotice({
  error,
  title,
  onRetry,
}: {
  error: unknown;
  title?: string;
  onRetry?: () => void;
}) {
  const presentation = presentApiError(error);
  return (
    <div
      role="alert"
      className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/5 p-4 text-sm text-[var(--danger)]"
    >
      <p className="font-semibold">{title ?? presentation.title}</p>
      <p className="mt-1 leading-5 text-[var(--muted-strong)]">{presentation.message}</p>
      <p className="mt-1 text-xs opacity-80">Reason code {presentation.code}</p>
      {presentation.requestId ? (
        <p className="mt-1 break-all text-xs opacity-80">Request {presentation.requestId}</p>
      ) : null}
      {onRetry ? (
        <button type="button" className={`${dangerButtonClass} mt-3`} onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "warning" | "danger" | "success";
}) {
  const toneClass = {
    info: "border-[var(--lumi-blue)]/30 bg-[var(--lumi-blue-soft)] text-[var(--civic-navy)]",
    warning: "border-[var(--warning)]/45 bg-[var(--warning)]/10 text-[var(--civic-navy)]",
    danger: "border-[var(--danger)]/30 bg-[var(--danger)]/5 text-[var(--danger)]",
    success: "border-[var(--success)]/30 bg-[var(--success)]/5 text-[var(--success)]",
  }[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`rounded-lg border p-3 text-sm leading-5 ${toneClass}`}
    >
      {children}
    </div>
  );
}

export function EmptyState({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="p-6">
      <p className="text-sm font-semibold text-[var(--civic-navy)]">{title}</p>
      <p className="mt-1 max-w-2xl text-sm leading-5 text-[var(--muted-strong)]">{copy}</p>
    </div>
  );
}

export function PermissionState({ resource }: { resource: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-hover)] p-5 shadow-[var(--shadow)]">
      <p className="text-sm font-semibold text-[var(--civic-navy)]">Access not permitted</p>
      <p className="mt-1 text-sm leading-5 text-[var(--muted-strong)]">
        Your current membership cannot view {resource}. Ask an administrator to review the adoption
        data permission for this organization.
      </p>
    </div>
  );
}

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  neutral: "bg-[var(--panel-strong)] text-[var(--muted-strong)]",
  info: "bg-[var(--lumi-blue-soft)] text-[var(--lumi-blue)]",
  success: "bg-[var(--success)]/10 text-[var(--success)]",
  warning: "bg-[var(--warning)]/15 text-[var(--civic-navy)]",
  danger: "bg-[var(--danger)]/10 text-[var(--danger)]",
};

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${TONE_CLASS[tone]}`}>
      {children}
    </span>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="break-all font-mono text-xs text-[var(--muted-strong)]">{children}</code>;
}

export function DateTime({ value, label }: { value: string | null; label?: string }) {
  if (!value) {
    return <span className="text-xs text-[var(--muted)]">{label ?? "never"}</span>;
  }
  const parsed = new Date(value);
  const readable = Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
  return (
    <time dateTime={value} className="text-xs tabular-nums text-[var(--muted-strong)]">
      {readable}
    </time>
  );
}

export function DefinitionRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold tracking-[0.08em] text-[var(--muted)] uppercase">
        {label}
      </dt>
      <dd className="mt-1 text-sm text-[var(--civic-navy)]">{children}</dd>
    </div>
  );
}

/**
 * The stage ladder.
 *
 * A vertical list of the six F26 stages, in order, with the reached rungs filled
 * and the current one marked. The managed rungs carry a left rule so the point at
 * which an organization takes over is visible without reading any text — that
 * boundary is the one a user deciding whether to adopt needs to see.
 */
export function StageLadder({ steps }: { steps: StageStep[] }) {
  return (
    <ol className="space-y-0" aria-label="Adoption stages">
      {steps.map((step) => (
        <li
          key={step.stage}
          aria-current={step.current ? "step" : undefined}
          className={[
            "relative border-l-2 py-2 pl-4",
            step.managed ? "border-[var(--lumi-blue)]" : "border-[var(--border)]",
            step.current ? "bg-[var(--lumi-blue-soft)]/50" : "",
            step.reached ? "" : "opacity-60",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <p className="text-sm font-semibold text-[var(--civic-navy)]">
            {step.label}
            {step.current ? (
              <span className="ml-2 text-xs font-medium text-[var(--lumi-blue)]">current</span>
            ) : null}
          </p>
          <p className="mt-0.5 text-xs leading-5 text-[var(--muted-strong)]">{step.description}</p>
        </li>
      ))}
    </ol>
  );
}

export const primaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[var(--lumi-blue)] px-4 py-2 text-sm font-semibold text-white shadow-[var(--shadow-button)] outline-none transition hover:bg-[var(--lumi-blue-hover)] active:translate-y-px focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

export const secondaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[var(--lumi-blue)]/40 bg-[var(--panel)] px-3 py-2 text-sm font-semibold text-[var(--lumi-blue)] outline-none transition hover:border-[var(--lumi-blue)]/60 hover:bg-[var(--lumi-blue-soft)] active:translate-y-px focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

export const dangerButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[var(--danger)]/40 bg-[var(--panel)] px-3 py-2 text-sm font-semibold text-[var(--danger)] outline-none transition hover:bg-[var(--danger)]/5 active:translate-y-px focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

export const ghostButtonClass =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-xs font-semibold text-[var(--muted-strong)] outline-none transition hover:bg-[var(--panel-hover)] hover:text-[var(--foreground)] focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
