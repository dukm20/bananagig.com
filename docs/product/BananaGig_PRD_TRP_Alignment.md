# BananaGig PRD/TRP Alignment

## Purpose

This document makes BananaGig's defining product requirement explicit and canonical for all future product, architecture, engineering, UI/UX, and implementation work.

It should be treated as a product-alignment source for Claude Code and merged into the repository's canonical PRD, roadmap, project state, implementation history, and relevant skills.

---

# 1. Canonical Product Definition

## 1.1 BananaGig's defining TRP

**BananaGig is a neighborhood demand-bundling marketplace.**

Customers book eligible services at their location at the **current bookable price**. As additional qualifying nearby bookings join the same provider neighborhood service run - a **BananaDrop** - provider-defined participation thresholds may unlock lower service prices.

Eligible existing bookings receive later price reductions according to BananaGig's explicit **price-protection rules**.

Providers use BananaDrops to cluster work geographically, improve route efficiency, and offer lower prices while retaining control over:

- eligible services;
- neighborhood/service area;
- capacity;
- service date/time windows;
- joining deadline;
- pricing tiers;
- price floor;
- available slots.

BananaDrop is not a later promotion, growth feature, coupon mechanism, or optional enhancement. It is a **first-class core marketplace domain**.

## 1.2 Customer value proposition

> **Book locally. More neighbors join. Everyone eligible can pay less.**

A customer should always understand:

1. what they can book now;
2. what the current price is;
3. whether their booking is confirmed;
4. what lower price can unlock next;
5. how many qualifying bookings are still needed;
6. how much capacity remains;
7. when the group closes;
8. whether later price drops are protected for their booking.

## 1.3 Provider value proposition

> **Cluster more jobs in one neighborhood, improve operating efficiency, and share some of that efficiency with customers through provider-controlled price tiers.**

A provider should always understand:

1. how many qualifying bookings are confirmed;
2. how much capacity remains;
3. the current unlocked price tier;
4. the next threshold;
5. the financial impact of the next tier;
6. the service window and joining deadline;
7. route/neighborhood density;
8. whether additional demand fits within available time/resources.

---

# 2. Core Domain Chain

BananaGig's core domain chain is:

```text
Category
  -> Service Type
  -> Gig Template
  -> Provider Gig
  -> BananaDrop
  -> Qualifying Booking
  -> Participation
  -> Price Tier
  -> Price Protection / Adjustment
```

Ownership must remain explicit:

| Domain | Owner |
|---|---|
| Category | Platform |
| Service Type | Platform |
| Gig Template | Platform |
| Provider Gig | Provider |
| BananaDrop | Provider-configured, platform-governed |
| Qualification rules | Platform |
| Capacity | Provider-defined within platform rules |
| Pricing tiers | Provider-defined within platform rules |
| Participation state | Platform authoritative |
| Tier evaluation | Platform authoritative |
| Price protection | Platform authoritative |
| Booking | Customer/provider marketplace domain |
| Go-Live eligibility | PRO-003 |

---

# 3. Core Product Invariants

These are non-negotiable engineering/product invariants unless explicitly changed by a future approved product decision.

1. **BananaDrop is first-class domain state.**
2. A customer books at the **current eligible/bookable price**.
3. A future lower tier is conditional until its threshold is reached.
4. The UI must never present a future price as the currently bookable price.
5. Eligible existing bookings may receive later reductions only according to explicit price-protection policy.
6. The provider controls eligible services, neighborhood/service area, capacity, time window, deadline, tier prices, and price floor.
7. The platform controls qualification correctness, tier evaluation, concurrency, capacity integrity, auditability, and price-protection execution.
8. Additional customer demand must **never automatically create capacity**.
9. Provider capacity, time, and resources remain authoritative constraints.
10. Multiple compatible service types may contribute to one BananaDrop.
11. Compatible services may retain different base prices and different pricing ladders.
12. One BananaDrop must **not** be modeled as one universal service price.
13. Customer and provider views must derive from the same authoritative group participation/tier state.
14. Search, booking, pricing, availability, notifications, and UI must become BananaDrop-aware.
15. Banana Credits are a provider monetization mechanism, not the main customer-facing value proposition.
16. Provider role, provider registration, verification, Go-Live eligibility, booking eligibility, and BananaDrop eligibility remain separate concepts.
17. Published pricing thresholds are auditable and deterministic.
18. Price-tier transitions must be concurrency-safe and idempotent.
19. Historical booking prices and tier transitions must remain explainable after later changes.
20. No silent repricing outside explicit, auditable price-protection rules.

---

# 4. BananaDrop Core Experience

## 4.1 Provider creates a BananaDrop

Provider defines:

- market/neighborhood/service area;
- eligible provider Gig(s)/service type(s);
- service date;
- one or more service windows;
- joining deadline;
- available capacity;
- participation thresholds;
- service-specific price tiers;
- minimum acceptable price/price floor;
- optional compatibility rules between services.

## 4.2 Customer books immediately

The customer's booking is confirmed according to normal booking/capacity rules.

The current price is displayed clearly as the price available **now**.

The customer does not need to wait for the neighborhood group to fill before getting a confirmed booking, unless a future explicit BananaDrop mode says otherwise.

## 4.3 Group participation grows

Qualifying bookings contribute to BananaDrop participation.

The group state must expose:

- current qualifying count;
- next threshold;
- remaining bookings to next threshold;
- current price per service;
- next price per service;
- remaining capacity;
- joining deadline.

## 4.4 Threshold unlock

When a threshold is reached:

- the authoritative tier changes atomically;
- eligible bookings receive the new protected price according to policy;
- the event is audited;
- affected users can be notified;
- future booking surfaces immediately show the newly unlocked current price.

---

# 5. Compatible Services and Service-Specific Pricing

A BananaDrop may include compatible services that contribute toward shared neighborhood participation.

However, each service may retain its own pricing ladder.

Example:

| Service | Current price | Next price | Participation |
|---|---:|---:|---|
| Exterior Wash | $55 | $50 | Counts toward group |
| Interior Detail | $85 | $78 | Counts toward same group |
| Full Detail | $120 | $110 | Counts toward same group |

Therefore:

- BananaDrop participation may be shared;
- service prices remain service-specific;
- service thresholds may be shared or mapped by policy;
- one group does not imply one universal price;
- price-protection adjustment must be calculated for the customer's actual booked service.

---

# 6. Customer Portal Requirements

The customer portal must revolve around these questions:

> What can I book nearby? What does it cost now? How can the price fall? Is my booking confirmed?

## 6.1 Home / Discover

Prioritize:

1. location;
2. service;
3. nearby BananaDrops;
4. current price;
5. next lower price;
6. group progress;
7. service date/window;
8. available capacity.

A BananaDrop card should be understandable without opening the detail page.

Example signature presentation:

```text
$55 now
$50 when 1 more neighbor joins
4 / 5 qualifying bookings
Saturday, 10 AM-2 PM
2 slots left
[Book for $55]
```

## 6.2 Gig / BananaDrop Detail

Show:

- service scope;
- provider;
- current price;
- next threshold price;
- threshold progress;
- qualifying neighborhood/service area;
- date/window;
- joining deadline;
- remaining slots;
- price-protection explanation;
- booking CTA.

## 6.3 Checkout

Show:

- selected service;
- address;
- appointment window;
- current bookable price;
- charges/fees;
- price-protection policy;
- clear statement that future lower tier is conditional until unlocked.

## 6.4 Active booking

Show:

- confirmed appointment;
- customer's current applicable price;
- BananaDrop participation;
- next threshold;
- any unlocked reduction;
- service-day status.

## 6.5 Invite neighbors

Provide shareable neighborhood offer links containing:

- service/offer context;
- current price;
- next possible price;
- deadline;
- eligibility explanation.

## 6.6 Receipt / History

Show:

- final service price;
- applicable fees;
- savings due to BananaDrop participation;
- original booked price if useful;
- final unlocked tier;
- review access.

---

# 7. Provider Portal Requirements

The provider portal must revolve around these questions:

> Where should I work? How many jobs can I accept? What discount can I offer? What happens financially at the next tier?

## 7.1 Overview

Show:

- active BananaDrops;
- confirmed bookings;
- current tier;
- next threshold;
- remaining capacity;
- deadlines;
- service windows;
- upcoming neighborhood runs.

## 7.2 Create / Manage BananaDrop

Provider configures:

- neighborhood/service area;
- eligible Gigs/services;
- date;
- service window;
- joining deadline;
- capacity;
- pricing tiers;
- floor price.

## 7.3 Pricing tier editor

For each tier show:

- threshold;
- service price;
- number of expected bookings;
- gross service revenue;
- floor-price impact.

Future extensions may show:

- jobs/hour;
- estimated driving reduction;
- route density;
- revenue/hour.

Do not implement those future metrics until supported by real routing/operations data.

## 7.4 Bookings

Show:

- confirmed jobs;
- service type;
- appointment window;
- customer requirements;
- applicable service price;
- tier/price-protection state.

## 7.5 Schedule / Route

Eventually organize jobs by:

- neighborhood;
- service window;
- travel sequence;
- resources;
- provider capacity.

## 7.6 Earnings

Show:

- final service revenue;
- tier reductions;
- platform charges;
- payout status;
- BananaDrop savings/economics context.

---

# 8. Shared Customer/Provider Group State

Both portals must use the same authoritative state for:

| Shared state | Requirement |
|---|---|
| Qualifying participation | Same qualification engine |
| Current tier | Same tier engine |
| Next threshold | Same threshold calculation |
| Remaining capacity | Same capacity authority |
| Deadline | Same closing timestamp |
| Price protection | Same policy/evaluation |
| Booking changes | Same cancellation/reschedule consequences |

No client may independently calculate authoritative group progress or final protected price.

---

# 9. Architecture Impact - Future Implementation

This document does not implement database structures yet, but future architecture should explicitly support:

## 9.1 BananaDrop aggregate

Likely responsibilities:

- provider ownership;
- market/neighborhood context;
- eligible services/Gigs;
- service window;
- joining deadline;
- capacity;
- lifecycle;
- version/revision for concurrency.

## 9.2 Service compatibility

Must support:

- multiple compatible services;
- shared contribution rules;
- service-specific pricing outcomes;
- explicit compatibility definitions.

## 9.3 Pricing tiers

Must support:

- provider-defined thresholds;
- provider-defined prices/floors;
- service-specific tier prices;
- immutable/auditable published tier configurations where necessary.

## 9.4 Qualification engine

Must determine whether a booking contributes based on authoritative factors such as:

- provider;
- BananaDrop;
- service compatibility;
- geography;
- time/date;
- booking state;
- deadline;
- capacity;
- cancellation/reschedule status.

## 9.5 Participation engine

Must be concurrency-safe and deterministic.

## 9.6 Tier engine

Must derive:

- current tier;
- next tier;
- remaining qualifying bookings;
- service-specific current/next prices.

## 9.7 Price protection

Must preserve:

- booked price;
- unlocked lower price;
- final applicable price;
- adjustment history;
- reason/tier transition;
- idempotency.

## 9.8 Capacity

Must never increase automatically because demand increased.

## 9.9 Deadlines

Must define clear behavior for:

- joining cutoff;
- final tier;
- late bookings;
- expiration;
- provider cancellation;
- customer cancellations.

## 9.10 Events / audit

Likely future events:

- BananaDropCreated
- BananaDropPublished
- BananaDropBookingQualified
- BananaDropBookingUnqualified
- BananaDropTierUnlocked
- BananaDropPriceAdjusted
- BananaDropCapacityChanged
- BananaDropClosed
- BananaDropExpired

Event payloads must avoid unnecessary PII.

---

# 10. Revised Implementation Roadmap

Completed checkpoints remain unchanged.

## Current position

- ✅ CAT-003 - Provider GigMenu + Gig Versioning
- ⏭️ CAT-004 - Variants / Add-ons / Media

## Provider and supply foundation

- ⬜ PRO-002 - Provider Public Profile
- ⬜ PRO-003 - Provider Go-Live Eligibility
- ⬜ CAP-001 - Availability Rules
- ⬜ CAP-002 - Slot Generation
- ⬜ CAP-003 - Atomic Slot Holds
- ⬜ AREA-001 - Provider Service Areas

## BananaDrop core - moved earlier because this is the TRP

- ⬜ DROP-001 - BananaDrop Core Domain
- ⬜ DROP-002 - Eligible Services / Compatibility
- ⬜ DROP-003 - Neighborhood / Territory Definition
- ⬜ DROP-004 - Capacity + Service Windows
- ⬜ DROP-005 - Provider Pricing Tiers
- ⬜ DROP-006 - Qualification / Participation Engine
- ⬜ DROP-007 - Current Tier / Next Tier Engine
- ⬜ DROP-008 - Price Protection
- ⬜ DROP-009 - Deadline / Closing / Expiration
- ⬜ DROP-010 - Provider BananaDrop Management

## Search

- ⬜ SEARCH-001 - Marketplace Eligibility
- ⬜ SEARCH-002 - Gig / BananaDrop Ranking
- ⬜ SEARCH-003 - Neighborhood Density / Proximity Signals

## Full application design foundation

- ⬜ UI-BASE-001 - Full BananaGig Apple + Uber/Base Web Design System Retrofit

UI-BASE-001 must retrofit **all screens already built and all future screens**.

## Customer experience

- ⬜ CU-01 - BananaDrop-aware Home / Discovery
- ⬜ CU-02 - Gig / BananaDrop Detail
- ⬜ CU-03 - Auth / Signup / Verification
- ⬜ CU-04 - Invite Neighbors / Sharing

## Booking

- ⬜ BOOK-001 - Booking Intent
- ⬜ BOOK-002 - BananaDrop Qualification
- ⬜ BOOK-003 - Booking Confirmation
- ⬜ BOOK-004 - Group Participation Attachment
- ⬜ BOOK-005 - Booking State Machine
- ⬜ BOOK-006 - Capacity / No-overlap Enforcement
- ⬜ BOOK-007 - Reschedule
- ⬜ BOOK-008 - Booking History

## BananaDrop settlement / lifecycle

- ⬜ DROP-011 - Threshold Unlock Processing
- ⬜ DROP-012 - Existing Booking Price Adjustment
- ⬜ DROP-013 - Final BananaDrop Price
- ⬜ DROP-014 - Cancellation / Minimum Threshold
- ⬜ DROP-015 - Notifications
- ⬜ DROP-016 - Analytics

## Later roadmap blocks remain required

Continue afterward with:

- Provider subscriptions
- Banana Credits
- Fulfillment
- Messaging
- Masked calling
- Live tracking
- Ratings/reviews
- Cancellations/disputes
- Provider Business
- Growth
- Customer service payments
- Finance/tax/accounting
- Account lifecycle
- Admin/operations
- NFR hardening/release readiness

---

# 11. UI/UX Standard - Entire Application

BananaGig's complete application experience must follow:

## Apple-inspired principles

- simplicity;
- premium visual polish;
- strong hierarchy;
- restrained motion;
- platform conventions;
- clear touch interaction;
- calm layouts;
- excellent typography;
- progressive disclosure;
- minimal cognitive load.

## Uber / Base Web-inspired principles

Use Uber Base Web as the primary component-system reference for:

- spacing;
- typography scale;
- forms;
- navigation;
- buttons;
- lists;
- cards;
- drawers/modals;
- status feedback;
- accessibility;
- responsive behavior;
- operational consistency;
- design tokens;
- reusable component contracts.

## BananaGig identity

Do not visually clone Apple or Uber.

BananaGig keeps its own:

- brand;
- logo;
- voice;
- BananaDrop language;
- Banana Credits;
- provider workflows;
- neighborhood pricing identity.

## UI-BASE-001 retrofit scope

UI-BASE-001 must inventory and retrofit **every existing application screen**, including:

- account/profile;
- security/MFA;
- consent/privacy;
- provider registration;
- provider verification;
- GigMenu/editor;
- customer pages;
- provider pages;
- admin/internal pages;
- temporary infrastructure pages;
- all screens created before UI-BASE-001.

No existing screen is exempt because it was created earlier.

## Canonical BananaDrop UI components

UI-BASE-001 should define reusable components such as:

- `CurrentPrice`
- `NextPriceUnlock`
- `GroupProgress`
- `SlotsRemaining`
- `JoinDeadline`
- `PriceProtection`
- `NeighborhoodOfferCard`
- `ProviderTierEditor`
- `TierRevenuePreview`
- `NeighborhoodCapacity`
- `BananaDropStatus`

The primary BananaDrop visual hierarchy should usually be:

**Current price -> next lower price -> progress -> service/time -> capacity -> action**

---

# 12. Feature Prioritization

## Core marketplace / TRP

Highest product priority:

- BananaDrop;
- neighborhood grouping;
- capacity;
- tiered service pricing;
- price protection;
- provider route density;
- customer booking certainty;
- neighborhood progress;
- service-specific tier pricing;
- invite/share behavior.

## Supporting monetization

Important but secondary to the customer proposition:

- provider subscriptions;
- Banana Credits;
- sponsored placement;
- provider promotions;
- customer rewards.

Banana Credits must not replace BananaDrop as the primary customer-facing story.

---

# 13. MVP Definition

A meaningful BananaGig MVP is not complete until the neighborhood group-pricing loop works end-to-end.

## Provider MVP

- registration;
- verification;
- Gig creation;
- service area;
- availability;
- BananaDrop creation;
- capacity;
- tier pricing;
- booking visibility.

## Customer MVP

- search by service/location;
- nearby BananaDrops;
- current price;
- next threshold;
- progress;
- slots;
- deadline;
- booking;
- price protection;
- invite neighbors;
- active booking progress.

## Platform MVP

- qualification engine;
- participation engine;
- tier engine;
- capacity integrity;
- deadline handling;
- price-protection adjustment;
- cancellation/reschedule consistency;
- concurrency;
- auditability.

Without this loop, BananaGig may be a local-services marketplace, but it is not yet delivering its defining differentiator.

---

# 14. Claude Code Repository Update Instructions

When this document is added to the repository, Claude Code should perform a documentation/product-alignment checkpoint before implementing additional BananaDrop-dependent features.

Suggested checkpoint:

`PRD-TRP-001 - BananaGig Neighborhood Group Pricing Alignment`

The checkpoint should:

1. read the canonical PRD and this document;
2. update the PRD's executive/product-definition sections;
3. move BananaDrop core earlier in the roadmap;
4. update `PROJECT_STATE.md`;
5. update `IMPLEMENTATION_HISTORY.md`;
6. update/create the canonical feature roadmap;
7. update relevant provider/catalog/product skills where durable knowledge changes;
8. update UI-BASE-001 scope;
9. search the repository for conflicting descriptions;
10. correct documentation conflicts;
11. NOT create production migrations;
12. NOT change production API behavior;
13. run governance/docs consistency checks;
14. commit locally;
15. do not push automatically.

Suggested commit message:

```text
docs(PRD-TRP-001): make neighborhood group pricing the BananaGig core product model
```

---

# 15. Acceptance Criteria for PRD-TRP-001

- [x] BananaGig is explicitly described as a neighborhood demand-bundling marketplace.
- [x] BananaDrop is classified as CORE MARKETPLACE, not a later enhancement.
- [x] Customer and provider value propositions are explicit.
- [x] Core product invariants are documented.
- [x] Compatible-service/shared-participation behavior is documented.
- [x] Service-specific pricing ladders are documented.
- [x] Customer portal requirements are BananaDrop-aware.
- [x] Provider portal requirements are BananaDrop-aware.
- [x] Provider economics/tier preview requirements are included.
- [x] BananaDrop domain checkpoints are moved before search/customer booking UX.
- [x] Search roadmap is BananaDrop-aware.
- [x] UI-BASE-001 is defined as a retrofit of all existing and future screens.
- [x] Apple + Uber/Base Web design direction is canonical.
- [x] Banana Credits remain secondary/supporting to the customer value proposition.
- [x] Architecture impact notes are documented without premature schema design.
- [x] Conflicting repository documentation is corrected.
- [x] No production schema/API behavior is changed in this checkpoint.
- [x] Repository governance checks pass.
- [x] One local documentation commit is created.
- [x] Nothing is pushed automatically.

---

Verification notes (PRD-TRP-001, 2026-10-18): the governance checks run were `project-state:check`, `skills:check`, the governance script tests, format, boundaries and lint on the touched files. `data-model:check` was not applicable (no schema change) and could not run in the isolated working copy used for this commit. Conflicting repository documentation was limited to DEBT-0092, DEBT-0093 and the out-of-scope list of `PROVIDER_GIGS.md` (corrected); the PRD Word file is kept outside git and its differences are listed in [`PRD_RECONCILIATION.md`](PRD_RECONCILIATION.md). The roadmap is [`ROADMAP.md`](ROADMAP.md).

---

# 16. Canonical Rule for Future Agents

All future BananaGig agents should treat the following as product truth unless the owner explicitly changes it:

> **BananaGig's defining differentiator is provider-controlled neighborhood group pricing through BananaDrops. Customers can book immediately at the current eligible price, while additional qualifying neighborhood demand can unlock lower protected prices. The complete customer and provider experience, search, booking, pricing, capacity, availability, notifications, and UI should be designed around this mechanism.**

