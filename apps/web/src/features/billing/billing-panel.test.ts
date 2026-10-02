import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import fixture from "../../../../../docs/implementation/fixtures/p06-contracts-v1.json";

import {
  decodeEntitlementProjection,
  decodeProviderEntitlementProjection,
  decodeSubscription,
  findProviderIdentifier,
  isProviderIdentifier,
  type BillingApi,
  type BillingSnapshot,
} from "./api";
import { BillingPanel } from "./billing-panel";
import { DOWNGRADE_HONESTY_STATEMENT } from "./downgrade";

const ORG_ID = fixture.entitlements.org_id;

// V04-007 -- THE FIXTURE IS RELATIVE TO THE CLOCK, AND SAYS SO.
//
// These four instants were literal dates. `license-state.ts` compares each of them against
// `input.now` (`graceEnded = grace !== null && grace <= now`), so the moment the wall clock passed
// 2026-09-26 the fixture stopped describing the state the tests assert: the panel correctly stopped
// rendering `license_grace_active`, and TWO assertions failed with a 2026-10-02 `pnpm check` that had
// been green days earlier. Nothing in the product changed.
//
// This is the same class of defect this repository already paid for in `verify:budget-concurrency`,
// whose fixtures used a literal expiry and read 27/27 at 23:59 and 23/25 at 00:36 with NO code change
// -- except that one made nothing happen, and this one made the asserted thing stop happening.
// `current_period_ends_at` (2026-10-01) had already expired a day before that run, so the file had
// been decaying quietly for a week.
//
// The offsets preserve the ORIGINAL relationships exactly (policy fresh +15min, grace +1d, period end
// +5.8d, offline validity +6.8d from a nominal "now" of 2026-09-25), so the fixture still means what
// it meant when it was written -- it just means it on any day the suite is run.
const NOW = Date.now();
const inDays = (days: number) => new Date(NOW + days * 86_400_000).toISOString();

const subscription = decodeSubscription({
  subscription_id: fixture.entitlements.subscription_id,
  org_id: ORG_ID,
  plan_key: "team",
  status: "grace",
  grace_expires_at: inDays(1),
  current_period_ends_at: inDays(5.8),
  version: 4,
});

const entitlements = decodeEntitlementProjection({
  org_id: ORG_ID,
  plan_key: "team",
  status: "grace",
  policy_fresh_until: inDays(15 / 96),
  offline_valid_until: inDays(6.8),
  entitlements: [
    { key: "org.max_members", value: 25, source: "plan" },
    { key: "automations.max_active", value: 100, source: "plan" },
    { key: "webhooks.enabled", value: true, source: "platform_default" },
    { key: "scim.enabled", value: true, source: "subscription" },
    { key: "sso.enabled", value: true, source: "internal_override" },
    { key: "exports.enabled", value: true },
  ],
});

const provider = decodeProviderEntitlementProjection(fixture.provider_entitlements);

const snapshot: BillingSnapshot = {
  orgId: ORG_ID,
  subscription,
  entitlements,
  provider,
  policy: {
    schema_version: 1,
    policy_fresh_seconds: 900,
    local_offline_grace_seconds: 604800,
    cloud_control_plane_grace_seconds: 86400,
    platform_paid_inference_grace_seconds: 0,
  },
};

const api: BillingApi = {
  getSubscription: async () => subscription,
  getEntitlements: async () => entitlements,
  getProviderEntitlement: async () => provider,
};

function render(): string {
  return renderToStaticMarkup(
    createElement(BillingPanel, { orgId: ORG_ID, api, initialData: snapshot, canManage: true }),
  );
}

/** The same snapshot, but with the server reporting one resource over limit. */
const overLimitEntitlements = decodeEntitlementProjection({
  org_id: ORG_ID,
  plan_key: "team",
  status: "grace",
  policy_fresh_until: inDays(15 / 96),
  offline_valid_until: inDays(6.8),
  entitlements: [
    { key: "org.max_members", value: 25, source: "plan" },
    { key: "automations.max_active", value: 100, source: "plan" },
  ],
  over_limit: [
    {
      entitlement_key: "automations.max_active",
      limit: 100,
      current: 118,
      over_by: 18,
      seat_based: false,
      remediation: [],
    },
  ],
});

const overLimitSnapshot: BillingSnapshot = { ...snapshot, entitlements: overLimitEntitlements };

function renderOverLimit(): string {
  const overLimitApi: BillingApi = {
    ...api,
    getEntitlements: async () => overLimitEntitlements,
  };
  return renderToStaticMarkup(
    createElement(BillingPanel, {
      orgId: ORG_ID,
      api: overLimitApi,
      initialData: overLimitSnapshot,
      canManage: true,
    }),
  );
}

/**
 * Rendered copy with HTML entity escaping undone, so assertions read as copy.
 *
 * The `<!-- -->` strip matters: React's server renderer inserts a comment
 * between adjacent text children so a browser cannot merge two separately
 * rendered strings into one word. Interpolated copy like
 * `{counted} counted limit{s} on this plan` therefore arrives as
 * `2<!-- --> counted limits<!-- --> on this plan`. Leaving the markers in makes
 * every assertion about a number that touches interpolation fail for a reason
 * that has nothing to do with the behaviour under test.
 */
function renderTextOf(html: string): string {
  return html
    .replaceAll("<!-- -->", "")
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function renderText(): string {
  return renderTextOf(render());
}

describe("billing panel rendered output", () => {
  /**
   * THE FIXTURE CONTROL. Runs FIRST, so every assertion below is known to be about the state it claims.
   *
   * The panel decides grace-dependent copy by comparing fixture instants against the wall clock
   * (`license-state.ts`: `graceEnded = grace <= now`). If every instant in this fixture is in the PAST,
   * the panel renders the expired-grace copy, every grace assertion below fails for one reason, and
   * nothing about the assertions themselves is being tested. That is precisely what happened with the
   * literal dates this replaced: the file went red on 2026-09-26 with no code change, and the failure
   * reads like a product regression.
   *
   * A fixture that makes nothing happen is the case where asking whether it happened is worth most --
   * the same lesson `verify:budget-concurrency` paid for, from the opposite direction.
   */
  it("PRECONDITION: every instant in this fixture is in the FUTURE, or the assertions below are about the wrong state", () => {
    const instants = {
      grace_expires_at: subscription.grace_expires_at ?? null,
      current_period_ends_at: subscription.current_period_ends_at ?? null,
      policy_fresh_until: entitlements.policy_fresh_until ?? null,
      offline_valid_until: entitlements.offline_valid_until ?? null,
    };
    const past = Object.entries(instants)
      .filter(([, value]) => value === null || Date.parse(String(value)) <= Date.now())
      .map(([key, value]) => `${key}=${String(value)}`);
    expect(
      past,
      "fixture instants must be in the future; the panel compares them against the wall clock",
    ).toEqual([]);
  });

  /**
   * WHY this asserts ORDER and VISIBLE COPY, not just presence.
   *
   * The four inputs were originally a leading definition list. The reference
   * moves that explanation to the end of the page, so the terms still render —
   * but a presence-only assertion would have passed just as happily against the
   * old leading position, which is the thing that changed. Asserting the
   * heading appears after the plan summary pins the hierarchy the reference
   * asks for, and asserting the four `term` / `doesNot` pairs keeps each input
   * still saying what it is not.
   */
  it("states the four decision inputs as distinct terms, after the plan summary", () => {
    const html = render();

    expect(html).toContain("Four separate inputs, never merged");
    for (const term of [
      "Authorization permission",
      "Lumi product entitlement",
      "Usage budget",
      "Upstream provider account status",
    ]) {
      expect(html).toContain(term);
    }
    expect(html).toContain("It does not grant or revoke a Lumi entitlement");

    // The plan leads; the disambiguation trails.
    expect(html.indexOf("Your current plan")).toBeGreaterThan(-1);
    expect(html.indexOf("Four separate inputs, never merged")).toBeGreaterThan(
      html.indexOf("Your current plan"),
    );
  });

  /**
   * WHY the separation is asserted structurally, not only in prose.
   *
   * "Plan details control product entitlements, not payment status" is the one
   * sentence the reference uses to keep a product plan from being read as a
   * payment status, and the subscription card is scoped the same way. If either
   * is dropped, the page starts implying that a lapsed payment method decides
   * what the product includes — which is the precise confusion P06-CR-002
   * exists to prevent.
   */
  it("keeps the product plan and the payment provider in separate, scoped cards", () => {
    const html = render();

    expect(html).toContain("Plan details control product entitlements, not payment status");
    expect(html).toContain("Subscription state");
    expect(html).toContain("product subscription state in Lumi Agents");
    expect(html).toContain("Billing is managed by our secure payment provider");

    // Three distinct surfaces, so no card can be mistaken for another.
    expect(html).toContain('aria-label="Plan and entitlements"');
    expect(html).toContain('aria-label="Subscription summary"');
    expect(html).toContain('aria-label="Upstream provider account status"');
  });

  it("makes the grace window unmistakable and says what stops when it ends", () => {
    const text = renderText();

    expect(text).toContain("Billing grace is active and time-limited");
    expect(text).toContain("Grace does not renew");
    expect(text).toContain("CLOUD CONTROL-PLANE GRACE ENDS");
    expect(text).toContain("SIGNED OFFLINE VALIDITY ENDS");
    expect(text).toContain("Stops first:");
    expect(text).toContain("cloud control-plane managed work, when the shorter cloud window ends");
    expect(text).toContain("Stops last:");
    expect(text).toContain("local-only work, when the signed offline validity instant passes");
    expect(text).toContain("No grace at all:");
  });

  it("renders the two expiries as two distinct clocks", () => {
    const html = render();

    expect(html).toContain("Two separate license clocks");
    expect(html).toContain("Signed offline validity");
    expect(html).toContain("Policy freshness");
    expect(html).toContain("Grace window");
    expect(html).toContain("This is a different clock from the one above");
  });

  it("shows each capability class with its own decision and reason", () => {
    const html = render();

    for (const label of [
      "Local-only work",
      "Cloud control-plane managed work",
      "Platform-paid inference",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("license_grace_active");
    expect(html).toContain("paid_inference_no_billing_grace");
    // Each deadline names the clock that bounds it rather than a bare date.
    expect(html).toContain("Basis: signed offline validity");
    expect(html).toContain("Basis: policy freshness");
  });

  it("renders every entitlement key with its precedence-chain source", () => {
    const html = render();

    expect(html).toContain("PRECEDENCE CHAIN, WEAKEST TO STRONGEST");
    expect(html).toContain("P1 · Platform default");
    expect(html).toContain("P2 · Plan");
    expect(html).toContain("P3 · Subscription grant");
    expect(html).toContain("P4 · Internal override");
    expect(html).toContain("org.max_members");
    expect(html).toContain("automations.max_active");
    // One value arrived without attribution, so it must be called out.
    expect(html).toContain("Source not itemized");
  });

  it("separates the provider projection and states what it cannot change", () => {
    const text = renderText();

    expect(text).toContain("UPSTREAM PROVIDER ACCOUNT — NOT A LUMI ENTITLEMENT");
    expect(text).toContain("never grants or revokes one");
    expect(text).toContain(
      "the provider's product, price, or customer reference. Those stay inside the adapter",
    );
    expect(text).toContain(
      "your Lumi plan, your Lumi subscription state, your effective entitlement values, your authorization permissions, or your usage budget",
    );
  });

  it("states the downgrade honesty requirement verbatim on the page", () => {
    const text = renderText();

    expect(text).toContain(DOWNGRADE_HONESTY_STATEMENT);
    expect(text).toContain("It does not delete anything that already exists");
    expect(text).toContain("remain readable");
  });

  it("refuses to submit a downgrade that cannot be previewed", () => {
    const html = render();

    expect(html).toContain("A downgrade cannot be submitted from this browser");
    expect(html).toContain("previewed before it is submitted");
    expect(html).toContain("Make the change in the");
  });

  it("reports how many entitlement keys and counted limits the projection carries", () => {
    // These numbers used to live in one trailing footnote. They now sit in the
    // two cards that actually use them — the plan summary and the usage
    // comparison — so the test follows the numbers to their new home rather
    // than asserting a sentence that no longer exists.
    const text = renderText();

    expect(text).toContain("Entitlement keys");
    expect(text).toContain("Counted limits");
    expect(text).toContain("2 counted limits on this plan");
  });

  /**
   * WHY the affordance is conditional.
   *
   * `docs/screens/lumi_plan_entitlements.webp` puts "Review over-limit
   * resources →" in the Usage vs. plan limits header. It is rendered only when
   * the server actually reported something over limit, because the target
   * region is mounted under the same condition. An always-present affordance
   * would either point at nothing or silently do nothing — and an affordance
   * that looks actionable but is not is worse than no affordance.
   */
  it("offers the over-limit review only when something is over limit", () => {
    const withinPlan = render();
    expect(withinPlan).not.toContain("Review over-limit resources");
    // Nothing over limit means the region is not mounted, so there is nothing
    // for the affordance to point at.
    expect(withinPlan).not.toContain('id="billing-over-limit"');

    const overLimit = renderOverLimit();
    expect(overLimit).toContain("Review over-limit resources");
    // The target exists, and it is focusable so the jump lands somewhere a
    // keyboard user can actually continue from.
    expect(overLimit).toContain('id="billing-over-limit"');
    expect(overLimit).toMatch(/id="billing-over-limit"[^>]*tabindex="-1"/);
    // The real overage is reported with the server's numbers, not a paraphrase.
    expect(overLimit).toContain("Over limit by 18");
    expect(overLimit).toContain("Resources already over the current plan limit");
  });

  it("shows no current-usage figure the server did not publish", () => {
    // The plan limit is published for every counted key; the current count is
    // published only for the one resource the server found over. Rendering a 0
    // for the rest would state the workspace has consumed nothing.
    const text = renderTextOf(renderOverLimit());
    expect(text).toContain("2 counted limits on this plan, 1 over limit");
    expect(text).toContain(
      "The server publishes a current count only for a resource already above its limit",
    );
    expect(text).toContain('A dash means "not published", never zero');
    // Exactly one row carries a real figure: the one the server counted.
    expect(text.match(/Over limit by 18/g) ?? []).toHaveLength(1);
  });

  it("offers no entitlement override control", () => {
    const html = render();

    expect(html).toContain("There is no override control on this surface");
    expect(html).not.toMatch(/type="file"/);
    expect(html).not.toContain("Revoke override");
    expect(html).not.toContain("Create override");
  });

  it("gives cancellation a confirmation with its consequence copy", () => {
    const html = render();

    expect(html).toContain("Cancel subscription…");
    expect(html).toContain("does not silently reactivate");
  });

  it("never renders a payment-provider product, price, or customer identifier", () => {
    const html = render();

    expect(findProviderIdentifier(html)).toBeNull();
    for (const forbidden of ["prod_", "price_", "cus_", "acct_"]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("ignores a snapshot that belongs to another organization", () => {
    const html = renderToStaticMarkup(
      createElement(BillingPanel, {
        orgId: ORG_ID,
        api: {
          getSubscription: async () => {
            throw new Error("should not be reached in this assertion");
          },
          getEntitlements: async () => {
            throw new Error("should not be reached in this assertion");
          },
          getProviderEntitlement: async () => {
            throw new Error("should not be reached in this assertion");
          },
        },
        initialData: { orgId: "org_ffffffffffffffffffffffffffffffff", ...snapshot },
        stale: true,
      }),
    );

    expect(html).toContain("Stale snapshot");
    expect(html).not.toContain("Grace window</dt>");
  });

  it("keeps an Lumi opaque ID out of the provider-identifier classifier", () => {
    expect(isProviderIdentifier(subscription.subscription_id)).toBe(false);
    expect(isProviderIdentifier(provider.projection_id)).toBe(false);
    expect(isProviderIdentifier(ORG_ID)).toBe(false);
  });
});
