/**
 * Email verification must be completable, and its failure must be explained.
 *
 * WHY THIS FILE EXISTS
 *
 * Found by V00-2026-09-27, and it is a whole file rather than one extra case
 * because the defect was the ABSENCE of behaviour:
 *
 *  * `verifyEmail()` was exported from `lib/api.ts` and called from nowhere. The
 *    auth screen showed a one-time code with no control to submit it, so
 *    `email_verified` could never become true. Because
 *    `Permission::requires_verified_email()` refuses every mutating permission,
 *    the first thing a new user tries — `POST /api/v1/orgs` — failed with 403
 *    `email_verification_required`, forever.
 *  * `presentApiError` mapped every 403 to "Ask an administrator to grant
 *    access", so the one 403 that is a self-service blocker was reported as a
 *    permissions problem.
 *
 * Absence is what a test cannot see, which is exactly why the first attempt at
 * covering this was worthless. The step is now a component of its own
 * (`email-verification-form.tsx`), so "there is a submit control and the field is
 * labelled" is an assertion a test can make and a future edit can break. The
 * end-to-end half — that submitting it issues the request and the user reaches an
 * organization — belongs to `apps/api/scripts/browser-probe.mjs`, which drives a
 * real browser against a real Worker. Both halves are recorded in
 * `docs/verification/runs/2026-09-27-v00-independent-reconstruction/findings/VFY-002-no-email-verification-step-in-web-ui.md`.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { EmailVerificationForm } from "./email-verification-form";
import { ApiClientError, presentApiError } from "@/lib/errors";

function render(overrides: Partial<Parameters<typeof EmailVerificationForm>[0]> = {}) {
  const props = {
    email: "person@example.com",
    code: "123456",
    busy: false,
    developmentCode: null,
    error: null,
    onCodeChange: vi.fn(),
    onSubmit: vi.fn(),
    onSkip: vi.fn(),
    ...overrides,
  };
  return { props, markup: renderToStaticMarkup(<EmailVerificationForm {...props} />) };
}

describe("EmailVerificationForm", () => {
  it("renders a submit control, so the one-time code can actually be sent", () => {
    const { markup } = render();
    expect(markup).toContain('type="submit"');
    expect(markup).toMatch(/Verify email and continue/);
  });

  it("labels the code field and names it, so a password manager and a screen reader can find it", () => {
    const { markup } = render();
    const id = /<input[^>]*id="([^"]+)"/.exec(markup)?.[1];
    expect(id).toBeTruthy();
    expect(markup).toContain(`for="${id}"`);
    expect(markup).toContain('name="one-time-code"');
    // `renderToStaticMarkup` emits React's own prop names verbatim, so the
    // camelCase forms are what actually appear in the markup.
    expect(markup).toContain('autoComplete="one-time-code"');
  });

  it("submits only once a code has been typed, and is disabled while the request is in flight", () => {
    // A six-character floor is a guard against submitting an empty field, not
    // validation of the server's code format.
    //
    // The DISABLED ATTRIBUTE is what is asserted, not the word "disabled": the
    // button's className contains `disabled:cursor-not-allowed`, so a naive
    // substring match passes on an enabled button and the assertion is worth
    // nothing. Scoping the match to the opening tag and requiring a real
    // attribute boundary is what makes this able to fail.
    const submitTag = (markup: string) => /<button[^>]*type="submit"[^>]*>/.exec(markup)?.[0] ?? "";
    const isDisabled = (markup: string) => /\sdisabled(?:=""|\s|>)/.test(submitTag(markup));

    expect(isDisabled(render({ code: "" }).markup)).toBe(true);
    expect(isDisabled(render({ code: "12345" }).markup)).toBe(true);
    expect(isDisabled(render({ code: "123456" }).markup)).toBe(false);
    expect(isDisabled(render({ busy: true, code: "123456" }).markup)).toBe(true);
  });

  it("keeps skipping available, because F01-002 permits a session before verification", () => {
    // Skipping must not be the primary action: the consequence of skipping is
    // that every mutating action is refused.
    const { markup } = render();
    expect(markup).toMatch(/Skip for now/);
    expect(markup.indexOf("Verify email and continue")).toBeLessThan(
      markup.indexOf("Skip for now"),
    );
  });

  it("shows the development code only when a build supplies one", () => {
    expect(render().markup).not.toMatch(/Development verification code/);
    expect(render({ developmentCode: "123456" }).markup).toMatch(/Development verification code/);
  });

  it("surfaces an error as an alert with a request ID, per F22-011", () => {
    const { markup } = render({
      error: {
        title: "That code did not work",
        message: "The code is wrong or has expired. Check the newest email and try again.",
        code: "verification_failed",
        requestId: "req_0123456789abcdef0123456789abcdef",
        retryable: true,
      },
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toMatch(/expired/);
    expect(markup).toContain("req_0123456789abcdef0123456789abcdef");
  });
});

function clientError(
  code: string,
  status: number,
  details: Record<string, unknown> = {},
): ApiClientError {
  return new ApiClientError({
    code,
    kind: "api",
    status,
    requestId: "req_0123456789abcdef0123456789abcdef",
    details,
    retryable: false,
  });
}

describe("presentApiError on a 403", () => {
  it("explains an unverified email as something the user fixes, not a permission problem", () => {
    // The exact shape the server returns for `POST /api/v1/orgs` from a
    // freshly-created account.
    const presentation = presentApiError(
      clientError("permission_denied", 403, { reason: "email_verification_required" }),
    );
    expect(presentation.title).not.toBe("Access not permitted");
    expect(presentation.title).toBe("Verify your email first");
    // "verify"/"verified"/"verification" — the copy must tell the user the
    // thing is theirs to fix.
    expect(presentation.message).toMatch(/verif/i);
    expect(presentation.message).not.toMatch(/administrator/i);
    // F22-011: the user must be told what can be retried.
    expect(presentation.retryable).toBe(true);
  });

  it("keeps the real copy for an actual permission failure", () => {
    const presentation = presentApiError(
      clientError("permission_denied", 403, { reason: "permission_denied" }),
    );
    expect(presentation.title).toBe("Access not permitted");
    expect(presentation.message).toMatch(/administrator/i);
  });

  it("does not let a spoofed reason on a non-403 status masquerade as a verification problem", () => {
    // The reason is only consulted for a 403. A 404 carrying the same reason
    // must not tell the user to go and verify their email.
    const presentation = presentApiError(
      clientError("not_found", 404, { reason: "email_verification_required" }),
    );
    expect(presentation.title).not.toBe("Verify your email first");
  });

  it("does not let a reason alone override a status that is not a 403", () => {
    for (const status of [400, 409, 500]) {
      const presentation = presentApiError(
        clientError("some_code", status, { reason: "email_verification_required" }),
      );
      expect(presentation.title).not.toBe("Verify your email first");
    }
  });
});
