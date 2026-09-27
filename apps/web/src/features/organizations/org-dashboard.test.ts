/**
 * The organization shell must stay reachable after the first organization
 * exists, and its tables must stay readable on a phone.
 *
 * WHY THIS FILE EXISTS
 *
 * Found by V00-2026-09-27 in a real browser against a real Worker:
 *
 *  * `showCreateOrg` was initialised from `me.organizations.length === 0` and was
 *    only ever set to `false`, so the create-organization panel was unreachable
 *    once a user belonged to any organization. F02-001 says a verified user may
 *    create an organization, and the API accepted a second one — only the UI
 *    hid it. It also made the organization switcher unreachable in practice,
 *    which is why `VI-UX-001` needed an API call to reach a two-organization
 *    state at all.
 *  * The Members table was `min-w-[620px]` inside `overflow-x-auto`, so at
 *    390 px the Role column and the role control were clipped. A document-level
 *    overflow check passed, because the clipping happened inside the scroll
 *    container, not on the document.
 *
 * These are component-level guards. The behavioural halves — that the control
 * actually creates a second organization, and that nothing is clipped at 390 px
 * — are `apps/api/scripts/browser-probe.mjs`'s job, because only a real browser
 * can measure a real layout.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./org-dashboard.tsx", import.meta.url)), "utf8");

describe("the create-organization panel is not a one-way latch", () => {
  it("has a control that can set the latch back to true", () => {
    // The defect was the absence of any `setShowCreateOrg(true)`. Asserting the
    // call exists is weak on its own, so the next two cases narrow it to a
    // control the user can actually reach.
    expect(source).toMatch(/setShowCreateOrg\(true\)/);
  });

  it("puts that control in the page header, after the switcher and before the content", () => {
    // F22's information-architecture tree has no top-level "create
    // organization" destination, so the control belongs beside the switcher
    // rather than inventing a nav item.
    //
    // The bound is structural — between the switcher's closing tag and the
    // start of the content column — not a character distance, which a single
    // explanatory comment can push past any threshold.
    const switcherAt = source.indexOf('id="org-switcher"');
    const switcherEnd = source.indexOf("</select>", switcherAt);
    const controlAt = source.indexOf("setShowCreateOrg(true)");
    const contentStarts = source.indexOf("<main", switcherEnd);
    expect(switcherAt).toBeGreaterThan(-1);
    expect(switcherEnd).toBeGreaterThan(switcherAt);
    expect(controlAt).toBeGreaterThan(switcherEnd);
    expect(contentStarts).toBeGreaterThan(controlAt);
  });

  it("only offers the control when the user already has an organization", () => {
    // With no organizations the create panel is already the whole page, so the
    // control would be a duplicate of the only action on screen.
    const control = source.slice(
      source.indexOf("{me.organizations.length > 0 ? (", source.indexOf('id="org-switcher"')),
      source.indexOf("setShowCreateOrg(true)", source.indexOf('id="org-switcher"')),
    );
    expect(control).toMatch(/me\.organizations\.length > 0/);
  });

  it("selects the organization it just created, so the user lands in it", () => {
    // Creating a second organization and being left staring at the first is a
    // silent-no-op from the user's point of view.
    expect(source).toMatch(/onCreated: \(created: Organization\) =>/);
    expect(source).toMatch(/setSelectedId\(created\.org_id\)/);
  });
});

describe("the members table stays readable on a narrow viewport", () => {
  it("does not force a minimum width that a phone cannot show", () => {
    // The clipped-column defect. `min-w-[620px]` inside `overflow-x-auto` is
    // the exact shape that produced it.
    //
    // Comments are stripped first: this file's own explanation of the defect
    // names the class, and matching prose would either fail forever or force
    // the explanation to be vague.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead) => lead);
    expect(code).not.toMatch(/min-w-\[620px\]/);
  });

  it("folds the two secondary columns into the member cell below sm", () => {
    // One table, not two: duplicating the markup for a mobile layout is how the
    // two copies drift. The secondary values move into the member cell, which
    // is visible at every width, so nothing is lost to a screen reader either.
    expect(source).toMatch(/className="hidden px-5 py-4 sm:table-cell"/);
    expect(source).toMatch(/className="mt-1 text-xs text-\[var\(--muted\)\] sm:hidden"/);
  });

  it("keeps the role control at full touch height and full width on a phone", () => {
    // AGENTS.md forbids trading target size for visual minimalism, and this
    // control is how an admin changes someone's role.
    // `min-w-[8.5rem]` is the measured requirement, not a preference: with three
    // visible columns the auto table layout squeezed this control to 36px wide and
    // pushed it to x=422..458 inside a 390px viewport, so the admin action was only
    // reachable by scrolling a container.
    expect(source).toMatch(/min-h-11 w-full min-w-\[8\.5rem\] max-w-44 rounded-lg/);
  });

  it("keeps a header scope on every column header", () => {
    // Added while reflowing the table: five `<th>` elements with no scope is
    // exactly the kind of thing a narrow-viewport rewrite quietly drops.
    const headers = source.match(/<th\b[^>]*>/g) ?? [];
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) {
      expect(header).toMatch(/scope="col"/);
    }
  });
});
