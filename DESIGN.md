# Lumi Landing Design System

Revision: Civic Editorial Intelligence + restrained liquid glass · September 2026

> Marketing adaptation of the canonical Lumi design language in
> `RunLumi/lumi-agents/DESIGN.md`. The shared Lumi identity is authoritative.
> This file narrows that system for `runlumi.app`; it does not invent a second brand.

## 0. Purpose

The landing page has one job:

> Make a serious operator understand, in under a minute, that Lumi helps the tools
> and work a company already has move together as one operating system.

It must communicate **vision + system + evidence + a concrete next step** without becoming
an AI spectacle, a four-product catalogue, or a consulting brochure.

The page should feel closer to a beautifully edited operating manual, annual report,
or systems map than a conventional startup template.

---

# 1. Shared Lumi identity

Preserve these ideas from the canonical design system:

- **Civic Editorial Intelligence** — institutional trust, editorial clarity, warm human texture.
- **Lit operating desk** — warm paper is the desk; white sheets are evidence and work.
- **Light only** — no dark theme. One intentional Civic Navy editorial inversion is allowed.
- **One type family** — Geist for display/body, Geist Mono only for technical fragments.
- **Folded-L geometry** — precise corners, brackets, rails, negative space, handoff lines.
- **Restrained material depth** — warm paper, opaque evidence sheets, and a separate liquid-glass control layer with navy-tinted depth.
- **Evidence before performance** — sources, freshness, permissions, approvals, worklogs.
- **Unconventional restraint** — fewer things, better ordered, with stronger meaning.

The landing page should never visually drift toward futuristic, magical, cyberpunk,
robotic, gamified, crypto-like, or trend-chasing AI aesthetics.

---

# 2. Positioning

## 2.1 Company-level proposition

Lumi is not presented as four unrelated products.

The system is:

```text
People
  ↕
Lumi Assistant — one front door
  ↕
Workspace · Lumi BI · Lumi Agents
coordinate · understand · act
  ↕
Shared company context
(memory · evidence · permissions · workflow state)
  ↕
Controlled actions
(permissions · approvals · verification)
  ↕
The systems the company already uses
```

The page therefore sells a **new operating model for the company**, not a collection of features.

## 2.2 Product roles

- **Lumi Assistant** — the universal front door: ask, delegate, follow through.
- **Lumi AI Workspace** — coordinate decisions, commitments, risks, and operating work.
- **Lumi BI** — understand what changed and trace conclusions to evidence.
- **Lumi Agents** — carry out bounded digital jobs with tools, worklogs, approvals, and verification.

**Customer taxonomy:** one way in, three core capabilities.

The Assistant is not a fourth equal product card. Shared context, permissions, model routing,
tool access, approvals, verification, and audit are platform capabilities and should remain
largely invisible until they explain trust or a buying requirement.

---

# 3. Visual philosophy

## 3.1 The mass-love layer

A first-time visitor should immediately feel:

> “This is clear, useful, and trustworthy.”

Require:

- obvious hierarchy;
- readable type;
- familiar navigation;
- one message per section;
- no clever interaction required to understand the system.

## 3.2 The designer-praise layer

A strong designer should notice:

> “This is restrained, consistent, unusually well edited.”

Require:

- intentional whitespace;
- precise grid;
- strong typographic rhythm;
- quiet paper texture;
- repeated folded-L line geometry;
- material states with a reason.

## 3.3 The operator layer

A CEO or operator should understand:

1. what Lumi is;
2. where it sits in the company;
3. what each product does;
4. how work moves through the stack;
5. why it can be trusted;
6. what to do next.

Visual polish that does not improve one of those six outcomes is not completion.

---

# 4. Material model

Lumi is a **lit operating desk**.

| Cue       | Meaning                    | Landing expression                                                       |
| --------- | -------------------------- | ------------------------------------------------------------------------ |
| Paper     | calm reading surface       | warm page canvas                                                         |
| Sheet     | product/evidence/work      | white surface, 1px border, lit top edge                                  |
| Ink       | authority                  | Civic Navy / Ink, never pure black                                       |
| Mark      | provenance/attention       | small blue rail, dot, bracket, clarity mark                              |
| Lift      | interaction                | navy-tinted elevation only                                               |
| Glass     | navigation above the work  | floating header and one workflow navigation dock; never reading surfaces |
| Seal      | authority                  | primary Lumi Blue CTA                                                    |
| Inversion | one editorial interruption | Civic Navy context section only                                          |

Every visible material needs a physical reason. Remove decoration that does not explain
hierarchy, state, affordance, provenance, or system structure.

---

# 5. Canonical color contract

Use the shared Lumi values exactly.

```css
--color-lumi-blue: #006093;
--color-lumi-blue-hover: #004f80;
--color-lumi-blue-active: #003e6a;
--color-lumi-blue-soft: #e4f3fc;

--color-civic-navy: #102a43;
--color-ink: #172033;
--color-soft-slate: #5e6677;

--color-paper-white: #f4f0e8;
--color-surface-white: #ffffff;
--color-archive-gray: #e7eaf0;
--color-border-subtle: #e7eaf0;
--color-border: #d9dee8;
--color-border-strong: #c8d0de;

--color-signal-amber: #f4a62a;
--color-amber-soft: #fff4dc;
--color-risk-red: #c2410c;
--color-red-soft: #fff1ec;
--color-success-green: #1f7a4d;
--color-green-soft: #e9f7ef;
```

Color temperament:

- **Paper / white / navy / slate:** 85–95%.
- **Lumi Blue:** 3–8%.
- **Status colors:** only when they carry real semantics.
- **Decorative color:** 0%.

Blue is authority, not wallpaper. A whole hero line does not need to be blue to feel like Lumi.

---

# 6. Typography

## 6.1 Family

```css
--font-sans:
  Geist, "Noto Sans", "Noto Sans Thai", "Noto Sans Arabic",
  "Noto Sans Devanagari", "Noto Sans JP", "Noto Sans KR", "Noto Sans SC",
  "Noto Sans TC", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
  "Segoe UI", sans-serif;

--font-mono:
  "Geist Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
```

One family. Authority comes from weight and tracking, not a second display face.

## 6.2 Marketing hierarchy

Hero:

```css
font-size: clamp(56px, 6.1vw, 82px);
line-height: 1.08;
font-weight: 560;
letter-spacing: -0.065em;
```

Vietnamese display uses `line-height: 1.14` (1.13 on mobile), lighter tracking
and natural wrapping. Never clip diacritics or shrink Vietnamese body text.
Self-host the variable Geist Latin and Vietnamese subsets with `font-display: swap`;
include the SIL Open Font License. Do not depend on a visitor request to a font CDN.

Hero body:

```css
font-size: clamp(18px, 2vw, 22px);
line-height: 1.55;
font-weight: 400;
```

Section headings should be large enough to read editorially but must not compete with the hero.

Rules:

- Civic Navy headings, never black.
- Body copy 16px minimum.
- Metadata 12px minimum.
- Tabular numbers for times, indexes, metrics.
- Test Vietnamese line breaks and diacritics.
- No ornamental italics, decorative serif, or fake editorial flourish.

---

# 7. Grid and spacing

Canonical desktop outer bound: **1200px**.

```css
desktop: 12 columns · 24px gap · ~80px outer breathing room
tablet: 40px outer margin · 20px gap
mobile: 20px outer margin · 16px gap
```

Spacing scale:

```css
4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48 · 64 · 80 · 96
```

Use whitespace to separate ideas, not to manufacture luxury.

Each section must answer one question:

- What is Lumi?
- How does the stack fit together?
- What does a day with Lumi look like?
- What does the system know?
- What does each product do?
- How does Lumi fit the existing software stack?
- Why should I trust it?
- What should I do next?

If a section answers two unrelated questions, split it.

---

# 8. Geometry and materials

## 8.1 Radius

```css
2px  tiny evidence detail
4px  compact detail
8px  cards, buttons, inputs
12px popovers
12px large editorial sheet
14px workflow navigation dock
16–20px floating header only
999px true chips only
```

No giant rounded SaaS panels. No playful blobs.

## 8.2 Borders

- 1px archival borders.
- 2px focus ring.
- 3px semantic severity rail only.
- Avoid boxing every row.
- Lines should feel like document structure and systems diagrams.

## 8.3 Elevation

Use navy-tinted shadows from the canonical system.

```css
--shadow-card:
  inset 0 1px 0 0 color-mix(in oklch, white 60%, transparent),
  0 1px 2px -1px color-mix(in oklch, #102a43 8%, transparent),
  0 8px 20px -10px color-mix(in oklch, #102a43 10%, transparent);

--shadow-button:
  inset 0 1px 0 0 color-mix(in oklch, white 22%, transparent),
  0 1px 2px 0 color-mix(in oklch, #102a43 22%, transparent);
```

No black drop shadows. No colored glow.

## 8.4 Liquid glass, translated for Lumi

Reference: [Apple Human Interface Guidelines — Materials](https://developer.apple.com/design/human-interface-guidelines/materials).
Apple places glass in the navigation/control layer and recommends restraint for custom controls.
This is a CSS interpretation of that hierarchy, not a claim to reproduce native optical refraction.

**Paper is the content. Glass is how you move through it.**

Use glass only for the floating header and the link dock attached to the hero's example.
Both must be genuine navigation, with keyboard focus and a meaningful destination.
Keep the system diagram, evidence, body text and product chapters opaque.
Never nest glass inside glass or blur a whole section.
Product chrome follows the same rule: the control plane applies this recipe to its
floating app header and its navigation dock, while forms, tables and content panels stay opaque.

```css
/* Opaque first: browsers without filters still get a complete material. */
background: #f9f7f2;
border: 1px solid rgba(255, 255, 255, 0.85);
box-shadow:
  inset 0 1px 0 #fff,
  inset 0 -1px 0 rgba(16, 42, 67, 0.08),
  0 8px 24px -16px rgba(16, 42, 67, 0.28),
  0 0 0 1px rgba(16, 42, 67, 0.07);
/* Within @supports only */
background: rgba(249, 247, 242, 0.84);
backdrop-filter: blur(24px) saturate(1.2);
```

The white edge suggests light from above; the navy edge grounds the control.
Tint comes from the existing paper and ink palette. No spectral rims, rainbow highlights,
animated distortion, pointer spotlights or extra accent colors.

- Keep opaque-enough material for text contrast over every section, including navy.
- Support the prefixed filter for Safari.
- `prefers-reduced-transparency: reduce` and `prefers-contrast: more` use opaque paper.
- Forced colors retain explicit borders and system button colors.
- Hover moves a control at most 1px; reduced motion removes transitions.
- At 320px, preserve the logo, language switch and contact action.
- This layer requires no JavaScript, canvas, WebGL or image generation.

---

# 9. Landing-page composition

The page is an edited explanation of how work moves, not a catalogue.

## 9.1 Hero — company first

A short two-part thesis: “Your company. Working as one.” / “Cả doanh nghiệp. Cùng một nhịp.”
The supporting paragraph must name the AI operating layer and connect people, data and tools.
A visitor must understand the proposition without interpreting the illustration.

Use one question-led example on an opaque white sheet. Label it **Illustrative / Minh họa**.
Assistant is the entry point; Workspace, BI and Agents appear as connected capabilities.
The attached glass dock links to the workflow below. Never simulate a live run, chat input,
completed job or verified result. No invented numbers or customer names.

## 9.2 The work between tools

A compact editorial bridge describes a recognizable cost: finding a number,
repeating context, chasing the next step. Avoid a second manifesto or repeated feature grid.

## 9.3 Follow one workflow

Show a sales-review question moving through four stages: ask, trace, decide, act.
The workflow is an illustration of the operating model, not a customer case study.
Do not use invented timestamps to imply an observed execution or promise a completion time.

## 9.4 Explain the system

People → Assistant → Workspace / BI / Agents → company context → controlled actions → existing systems.
Use a quiet dotted document grid, thin connectors and legible sheets.
State that deployment scope, features and connections are confirmed per use case.
Software categories are not a list of verified integrations.

## 9.5 Product chapters

Three editorial chapters, each with a distinct job, a clear explanation and an inspectable,
explicitly illustrative artifact. No four equal product cards. No fabricated dashboards.
Retain sources, ownership, limits and approval as the vocabulary of real work.

## 9.6 Company context

One Civic Navy inversion explains why the next question should not start from zero.
Use linked inputs and outputs; preserve readable contrast. No glass text panels in this section.

## 9.7 Trust and the first workflow

Present evidence, authority, human judgment and verification as design standards.
Explain how to start: choose one recurring job, check fit, define the evaluation, review the result.
Do not imply every roadmap capability is generally available.

## 9.8 A reason to begin

The final question is specific: which recurring report, handoff or unresolved question
will come around again next week? Invite the visitor to bring that work to Lumi.
The CTA opens an email draft with prompts for workflow, systems, bottleneck and desired result.
It must say that it opens email. No invisible form submission or invented response-time promise.

Desire comes from recognizing a better way to work. Urgency comes from a real recurring cost.
Never manufacture urgency with countdowns, limited places, competitive threats, fake adoption,
unsupported ROI or claims about what “every leading company” is doing.

---

# 10. Iconography

Use minimal line geometry that feels related to the folded-L mark:

- brackets;
- rails;
- annotation dots;
- document corners;
- simple directional paths.

Stroke: 1.75–2px.

Avoid:

- emoji;
- cartoon icons;
- 3D icons;
- gradient icon tiles;
- generic sparkle overload;
- mixed icon packs.

The four-point clarity mark means Lumi found, clarified, or verified something useful.
Use it rarely.

---

# 11. Photography

Photography exists to make Lumi feel grounded in real work, not to decorate the page.

Use:

- real shops, counters, warehouses, desks, paperwork, laptops, stock, tools;
- natural or available light;
- editorial framing;
- people absorbed in work rather than posing at camera;
- muted, believable color;
- images that reveal a real operating environment.

Avoid:

- handshake imagery;
- staged executive portraits;
- fake diversity collages;
- smiling call-center teams;
- futuristic blue rooms;
- generic “business success” stock photography;
- photos whose only message is “people in an office.”

Photography should appear as an editorial interruption between conceptual sections.
Do not place a full-bleed photo behind the hero headline.

When using Unsplash:

- use free-license images only, not Unsplash+;
- link the photographer/source in the caption;
- preserve meaningful alt text;
- crop with CSS rather than distorting the image;
- keep saturation slightly restrained so photographs live inside the Lumi paper system.

---

# 12. Language

The best Lumi copy sounds like a capable person explaining the product across a table.

Prefer:

- plain verbs;
- short sentences;
- familiar business words;
- one claim at a time;
- concrete effects on daily work;
- quiet confidence.

Replace abstract technology language whenever ordinary language says the same thing.

Prefer:

> Keep the systems that work. Make them work together.

Over:

> Add an intelligent orchestration layer to your existing technology stack.

Prefer:

> Hỏi doanh nghiệp. Lần theo bằng chứng.

Over:

> Khai thác dữ liệu bằng nền tảng AI thông minh đa tác tử.

Product names may contain “AI”, “Agents”, or “Autonomous” where those are the actual names.
Do not repeat those terms in surrounding copy merely to signal modernity.

Vietnamese should be chân phương, tự nhiên, mềm và chắc:

- tránh dịch sát tiếng Anh;
- tránh “tối ưu hóa”, “đột phá”, “nâng tầm”, “cách mạng hóa” nếu không có nghĩa cụ thể;
- ưu tiên cách nói một người chủ doanh nghiệp có thể nói lại cho người khác ngay sau khi đọc.

---

# 13. Motion

No video dependency.

Allowed:

- 120–180ms hover/focus transitions;
- 1px sheet lift;
- subtle line/rail state changes;
- no motion required to understand any content.

Forbidden:

- looping decorative motion;
- AI typing theatre;
- sparkle animation;
- parallax spectacle;
- bouncy spring effects.

Honor `prefers-reduced-motion`.

---



### 13.1 Parallax and purposeful alternatives

Updated 2026-10-03. This is a design contract for future changes, not evidence that effects are shipped. Existing brand, material, content, safety, and platform rules remain authoritative.

**Design decision:** earn visual impact through composition and a small number of useful motion moments. Prefer micro-interactions and a bounded scroll-driven sequence over large moving backgrounds. Keep reading, prices, evidence, and primary actions stable.

**Evidence boundary:** scroll-driven animation describes how progress is controlled, not guaranteed performance; parallax can itself be scroll-driven. Rendering cost depends on properties, assets, implementation, and device. WebGL/Three.js is not inherently lighter than simple parallax, and large movement can be uncomfortable with either technique. The limits below are project design choices, not universal research thresholds.

**Control-plane scope:** this guide contains landing-page treatments; their narrative motion does not apply to operational screens. Device policy, permissions, approvals, budgets, audit, run status, and tenant context remain stable and legible. No animated counters or simulated live runs. The existing HTML/CSS navigation layer remains independent of canvas/WebGL.

| Option | Appropriate use | Limits and static equivalent |
| --- | --- | --- |
| Traditional parallax | An optional depth cue in one explanatory marketing composition, where existing surface rules permit it. | Relative travel <=12px; never move essential text or controls. Disable on narrow viewports, coarse pointers, and reduced motion. No full-screen camera travel or fixed-background dependency. |
| Scroll-driven animations | Connect stages of a workflow or reveal an illustrative artifact as its section enters view. | Prefer transform/opacity: travel <=16px, scale 0.98–1.02. Keep content visible by default. Rotation, SVG morphing, and animated masks need explanatory value and profiling; they are not defaults. |
| Immersive 3D / WebGL | An optional explorable object when depth helps the visitor understand something a static view cannot. | Prefer HTML/SVG or modest CSS perspective first. Load 3D only for a justified, measured use; provide a complete static equivalent and accessible controls. Existing prohibitions on decorative 3D remain in force. |
| Kinetic / variable typography | Brief emphasis on one short marketing phrase. | Use only axes supported by the existing font. Keep body, prices, metrics, evidence, primary headlines, and CTA labels stable. No per-letter motion, shifting wraps, clipped diacritics, or continuous font-weight animation. |
| Sticky reveal / pinning | Hold an illustration alongside naturally scrolling explanatory steps. | Prefer CSS sticky; at most one narrative section. Release at its container boundary and use normal flow on short/narrow viewports. No wheel/touch interception, artificial scroll runway, or cards covering readable content. |
| Micro-interactions | Focus, press, disclosure, selected state, validation, and actual request outcomes. | Reuse existing timing tokens and <=1px control lift. Supply equivalent touch/keyboard feedback. No hover-only information, cursor chasing, or decorative loops. |

#### Implementation rules

- Start with complete semantic HTML and visible static content. Add CSS scroll/view timelines behind feature detection; unsupported browsers keep that baseline. A timed entrance is distinct from progress tied directly to scroll position. Do not add a library solely for a reveal.
- Prefer transform and opacity. Avoid animating layout dimensions, large blurs, or shadows while scrolling. Profile exceptions; avoid repeated layout reads/writes in scroll handlers and blanket `will-change` promotion.
- With `prefers-reduced-motion: reduce`, remove parallax, scroll-scrubbed movement, tilt, kinetic text, and animated pinning. Show the final static state, preserve immediate state feedback, and respond to preference changes during the visit. Native surfaces honor native accessibility settings.
- Cursor tilt is optional only on fine pointers with hover. Preserve touch scrolling, keyboard focus, text selection, find, anchor destinations, and browser back/forward scroll restoration. Never require animation, dragging, or canvas to reach an action.
- Any justified WebGL scene loads after essential content, caps resolution, stops rendering offscreen/in hidden tabs, releases resources, and falls back after context loss. No idle rendering loop; essential copy and controls stay outside canvas.
- Use one principal narrative scroll moment per page. Keep the hero understandable immediately; motion cannot simulate a live capability, customer result, completed task, or unobserved progress.

#### Acceptance when implementing motion

Compare the static and enhanced versions on the same device/network. Record asset cost, loading, interaction responsiveness, layout shifts, and a scroll trace. Simplify or remove an effect if it introduces visible stutter, delays content/action access, or shifts layout; desktop smoothness alone is insufficient evidence.

Inspect supported locales at 320/375/768/1440px, short viewports, long labels and Vietnamese diacritics. Test touch, keyboard, reduced motion, no JS where supported, unsupported timelines, CTA anchors, and success/failure states. For application shells, also verify the actual scrolling pane, virtualized lists, selection, and focus survive updates. Record which browsers/devices were actually tested; documentation-only changes do not prove runtime performance.

#### Sources

Reviewed 2026-10-03. Technical references support implementation; trend material is inspiration, not comparative performance evidence.

- [MDN: CSS scroll-driven animations](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Scroll-driven_animations) — scroll/view progress timelines.
- [web.dev: High-performance CSS animations](https://web.dev/articles/animations-guide) — rendering costs and profiling.
- [MDN: prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/prefers-reduced-motion) — user motion preferences.
- [MDN: WebGL best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices) — device limits and resource costs.
- [Figma: Web design trends](https://www.figma.com/resource-library/web-design-trends/) — inspiration for typography, motion, and immersive elements.


# 14. Copy

Lumi speaks like:

- a precise operating assistant;
- a calm chief of staff;
- a trustworthy analyst;
- a clear editor.

Use:

- short sentences;
- specific nouns;
- action verbs;
- visible ownership;
- evidence-based claims.

Avoid:

- “unlock productivity”;
- “supercharge your team”;
- “10x your workflow”;
- “AI-powered magic”;
- “revolutionize operations”;
- “seamlessly leverage”.

English and Vietnamese should communicate the same idea, not translate word-for-word when that hurts clarity.

---

# 15. Anti-patterns

Never ship:

- AI glow;
- neon or purple/blue startup gradients;
- 3D orb / brain / robot;
- floating dashboard collage;
- all-glass marketing surfaces;
- giant pill buttons;
- fake customer logos;
- fake testimonial quotes;
- invented ROI;
- unverified security badges;
- unexplained technical acronyms;
- repeated equal feature cards;
- unnecessary animation;
- four products presented as four isolated companies.

---

# 16. Accessibility and quality

- WCAG AA body text.
- 16px minimum body.
- Visible keyboard focus.
- 44px preferred touch hit area.
- 320px reflow without horizontal page scroll.
- Vietnamese tested without shrinking type.
- Reduced motion respected.
- Every glass control must have an opaque fallback and a reduced-transparency treatment.
- The page must remain fully understandable with CSS motion disabled.
- Product claims must match actual or intentionally stated roadmap capability.

---

# 17. Review gate

Before merging a visual change:

- [ ] Is glass confined to useful navigation, with opaque and reduced-transparency fallbacks?
- [ ] Are examples clearly labeled and capability scope stated?
- [ ] Does the CTA describe the actual email action?
- [ ] Is the page still unmistakably Lumi?
- [ ] Are canonical colors unchanged?
- [ ] Is blue used as authority rather than decoration?
- [ ] Is Paper White still the dominant canvas?
- [ ] Does each section answer one question?
- [ ] Does the hero explain the operating model before listing products?
- [ ] Does the stack read as one system?
- [ ] Does Assistant read as the front door, with Workspace/BI/Agents as the three core capabilities?
- [ ] Are product visuals inspectable work rather than fake screenshots?
- [ ] Are evidence, permissions, approvals, and worklogs treated as product value?
- [ ] Is the page strong without video?
- [ ] Are EN and VI structurally synchronized?
- [ ] Does mobile preserve the system story?
- [ ] Are focus, reduced motion, contrast, and long Vietnamese labels checked?
- [ ] Did we avoid fake proof?

The target feeling:

> Calm enough to trust. Ambitious enough to redraw how a company works.
