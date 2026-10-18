# BananaGig Feature Roadmap

This is the canonical feature roadmap of the repository. It is maintained by PRD-TRP-001 and by every later checkpoint that changes the plan (a checkpoint that completes updates the status here and in `docs/project/PROJECT_STATE.md`).

- **Product direction** (canonical, non-negotiable unless the owner changes it): [`BananaGig_PRD_TRP_Alignment.md`](BananaGig_PRD_TRP_Alignment.md). BananaGig is a neighborhood demand-bundling marketplace; BananaDrop (provider-controlled neighborhood group pricing) is a first-class core domain.
- **Numbered requirements** (CU-, PR-, SV-, AD-, R-, NF- identifiers): the PRD v9.4 (`BananaGig_PRD.docx`, kept locally outside git). Where the PRD and the alignment document differ, the alignment document wins on product definition, priority and ordering: see [`PRD_RECONCILIATION.md`](PRD_RECONCILIATION.md).
- **Current state** (what exists today): [`docs/project/PROJECT_STATE.md`](../project/PROJECT_STATE.md). **History**: [`docs/project/IMPLEMENTATION_HISTORY.md`](../project/IMPLEMENTATION_HISTORY.md).

Status legend: ✅ complete and committed · 🔄 in progress · ⏭️ next approved · ⬜ planned (not started, order is the plan).

## 1. The sequencing rules

1. **BananaDrop is core, so its domain is built before search and before the customer booking experience.** The DROP-001 to DROP-010 checkpoints sit after the provider and supply foundation (they need a live provider, a service area and availability to mean anything) and before SEARCH, the customer experience and booking.
2. **The provider and supply foundation comes first** (public profile, Go-Live, availability, slots, holds, service areas) because capacity and geography are inputs of a BananaDrop: additional demand must never create capacity (invariant 8, 9).
3. **The settlement and lifecycle half of BananaDrop (DROP-011 to DROP-016) follows booking**, because threshold unlock processing, price adjustment of existing bookings and final prices act on bookings.
4. **No checkpoint may couple Gig, Capacity and BananaDrop so that one cannot change without the others** (PRD 5.2). A BananaDrop references exact Gig versions and, for service-specific ladders, a variant key of that version; it never stores prices on a variant or add-on, and a Gig never knows about a BananaDrop.
5. **UI is temporary until UI-BASE-001.** Every screen built before UI-BASE-001 is a minimal functional placeholder; UI-BASE-001 retrofits all of them (section 5).
6. Completed checkpoints are not renumbered or rewritten by this roadmap.

## 2. Completed checkpoints

| ID | What it delivered | Date |
|---|---|---|
| INF-001 / INF-002 / INF-002A / INF-003 | Compose platform, application skeletons, role-named services, PostgreSQL/PostGIS foundation | 2026-10-05 |
| META-001 | Self-documenting repository: constitution, project state, history, learnings, debt, skills, governance scripts | 2026-10-05 |
| INF-004 | Keycloak identity baseline (PKCE web login, API JWT validation, admin separation) | 2026-10-05 |
| CFG-001 / CFG-001A | Configuration registry (typed parameters, scope hierarchy PLATFORM to DROP, change requests) | 2026-10-05/06 |
| CFG-002 | Content and localization registry | 2026-10-06 |
| GEO-001 / GEO-002 / GEO-002A | Geography registry (countries, currencies, time zones, markets) and the address model | 2026-10-07 |
| ID-001 | Application account linked to Keycloak, roles, active-role context | 2026-10-07 |
| ID-002 / ID-003 | Email and phone contacts with verification | 2026-10-07 / 10-16 |
| ID-004 | Application sessions, devices, MFA and recovery | 2026-10-16 |
| ID-005 | Consent and legal-version history | 2026-10-16 |
| ACC-001 | Shared account area (role-driven section registry) | 2026-10-16 |
| CAT-001 | Platform-owned catalogue: Category and Service Type | 2026-10-16 |
| CAT-002 | Versioned platform-owned Gig Templates | 2026-10-17 |
| PRO-001 | Provider registration on the existing account | 2026-10-17 |
| TRUST-001 | Provider verification and documents | 2026-10-18 |
| CI-001 to CI-004 | Corrective CI checkpoints | 2026-10-05/07 |
| CAT-003 | Provider GigMenu and Gig versioning (identity plus immutable versions bound to exact template versions) | 2026-10-18 |
| PRD-TRP-001 | This alignment: neighborhood group pricing as the core product model (documentation only) | 2026-10-18 |

## 3. Current position and the plan

- 🔄 **CAT-004 — Variants, Add-ons and Media.** In progress. A provider Gig version gains variants, add-ons and photos as version-owned children, so that a published version stays immutable. Designed so BananaDrop can consume it: a variant has a stable key within the Gig, its price is the Gig base plus a non-negative delta, and no tier, ladder or Drop flag is stored on it (service-specific ladders belong to DROP-005 and reference the exact Gig version and variant key). UI stays temporary.

### Provider and supply foundation

- ⬜ **PRO-002** — Provider Public Profile
- ⬜ **PRO-003** — Provider Go-Live Eligibility (owns "can this provider receive work"; separate from role, registration and verification)
- ⬜ **CAP-001** — Availability Rules
- ⬜ **CAP-002** — Slot Generation
- ⬜ **CAP-003** — Atomic Slot Holds
- ⬜ **AREA-001** — Provider Service Areas

### BananaDrop core (moved earlier because this is the TRP)

- ⬜ **DROP-001** — BananaDrop Core Domain (aggregate: provider ownership, market and neighborhood context, lifecycle, revision for concurrency)
- ⬜ **DROP-002** — Eligible Services / Compatibility (several compatible service types may contribute to one BananaDrop)
- ⬜ **DROP-003** — Neighborhood / Territory Definition
- ⬜ **DROP-004** — Capacity + Service Windows (capacity never increases because demand increased)
- ⬜ **DROP-005** — Provider Pricing Tiers (provider-defined thresholds, price floor, service-specific ladders; published tiers are auditable and deterministic)
- ⬜ **DROP-006** — Qualification / Participation Engine (concurrency-safe, deterministic)
- ⬜ **DROP-007** — Current Tier / Next Tier Engine (one authoritative state for customer and provider views)
- ⬜ **DROP-008** — Price Protection (booked price, unlocked lower price, final applicable price, adjustment history, idempotency)
- ⬜ **DROP-009** — Deadline / Closing / Expiration
- ⬜ **DROP-010** — Provider BananaDrop Management

### Search (BananaDrop-aware)

- ⬜ **SEARCH-001** — Marketplace Eligibility (separate from Go-Live; includes BananaDrop eligibility as its own concept)
- ⬜ **SEARCH-002** — Gig / BananaDrop Ranking
- ⬜ **SEARCH-003** — Neighborhood Density / Proximity Signals

### Full application design foundation

- ⬜ **UI-BASE-001** — Full BananaGig Apple + Uber/Base Web Design System Retrofit (scope in section 5)

### Customer experience

- ⬜ **CU-01** — BananaDrop-aware Home / Discovery
- ⬜ **CU-02** — Gig / BananaDrop Detail
- ⬜ **CU-03** — Auth / Signup / Verification (customer-facing flows over the identity already built)
- ⬜ **CU-04** — Invite Neighbors / Sharing

### Booking

- ⬜ **BOOK-001** — Booking Intent
- ⬜ **BOOK-002** — BananaDrop Qualification
- ⬜ **BOOK-003** — Booking Confirmation
- ⬜ **BOOK-004** — Group Participation Attachment
- ⬜ **BOOK-005** — Booking State Machine
- ⬜ **BOOK-006** — Capacity / No-overlap Enforcement
- ⬜ **BOOK-007** — Reschedule
- ⬜ **BOOK-008** — Booking History

### BananaDrop settlement / lifecycle

- ⬜ **DROP-011** — Threshold Unlock Processing
- ⬜ **DROP-012** — Existing Booking Price Adjustment
- ⬜ **DROP-013** — Final BananaDrop Price
- ⬜ **DROP-014** — Cancellation / Minimum Threshold
- ⬜ **DROP-015** — Notifications
- ⬜ **DROP-016** — Analytics

### Later roadmap blocks (still required, after the above)

Provider subscriptions · Banana Credits (a provider monetization mechanism, secondary to the customer proposition) · Fulfillment · Messaging · Masked calling · Live tracking · Ratings/reviews · Cancellations/disputes · Provider Business · Growth · Customer service payments · Finance/tax/accounting · Account lifecycle · Admin/operations · NFR hardening/release readiness.

## 4. The MVP bar

A meaningful BananaGig MVP is not complete until the neighborhood group-pricing loop works end to end (alignment document, section 13):

- **Provider:** registration, verification, Gig creation, service area, availability, BananaDrop creation, capacity, tier pricing, booking visibility.
- **Customer:** search by service and location, nearby BananaDrops, current price, next threshold, progress, slots, deadline, booking, price protection, invite neighbors, active booking progress.
- **Platform:** qualification engine, participation engine, tier engine, capacity integrity, deadline handling, price-protection adjustment, cancellation/reschedule consistency, concurrency, auditability.

## 5. UI-BASE-001 scope (defined here, built later)

UI-BASE-001 **retrofits every existing screen and defines every future one.** No screen is exempt because it was created earlier. Design direction (canonical): Apple-inspired principles (simplicity, premium polish, hierarchy, restrained motion, calm layouts, typography, progressive disclosure) with **Uber Base Web as the primary component-system reference** (spacing, type scale, forms, navigation, buttons, lists, cards, drawers/modals, status feedback, accessibility, responsive behavior, design tokens, component contracts). BananaGig keeps its own brand, logo, voice, BananaDrop language, Banana Credits and neighborhood pricing identity; it does not clone Apple or Uber.

Inventory to retrofit (screens that exist when this roadmap was written): the infrastructure pages (`/`, `/health`, `/system`, `/session`); sign-in and sign-out; the account area (profile, contact verification, security and MFA, sessions, language and region, privacy and data, roles); consent and privacy; email and phone verification; provider registration; provider verification (evidence upload); the GigMenu and the Gig editor (and, from CAT-004, variants, add-ons and photos); any admin or internal page; and every screen created between now and UI-BASE-001.

Canonical BananaDrop components UI-BASE-001 should define: `CurrentPrice`, `NextPriceUnlock`, `GroupProgress`, `SlotsRemaining`, `JoinDeadline`, `PriceProtection`, `NeighborhoodOfferCard`, `ProviderTierEditor`, `TierRevenuePreview`, `NeighborhoodCapacity`, `BananaDropStatus`. Primary visual hierarchy: **current price → next lower price → progress → service/time → capacity → action.** The UI must never present a future price as the currently bookable price.

Until then: temporary screens stay minimal, accessible (labels, errors linked to fields, keyboard operation, text status) and free of a competing design system.

## 6. How a checkpoint updates this file

A checkpoint that completes moves its row from section 3 to section 2, sets the next approved checkpoint, and states any change to the order with the reason. A change of order that touches the sequencing rules in section 1 needs the owner's decision.
