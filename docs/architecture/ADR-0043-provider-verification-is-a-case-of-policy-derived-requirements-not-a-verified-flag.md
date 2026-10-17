# ADR-0043 — Provider verification is a case of policy-derived requirements, never a `verified` flag: definition, rule and instance are separate, re-verification is a new cycle, and the overall state is derived

Status: ACCEPTED
Date: 2026-10-18
Checkpoint: TRUST-001

## Context

The PRD asks for provider verification that is configurable by category and market (identity, business, background, licence, insurance), with expiry tracking (SV-09.01), shown per check with the reason, resubmittable after a rejection (PR-02.03), and approved identity verification before a provider is bookable (PR-02.06). Several later checkpoints consume it (Go-Live, the public profile "ID Verified" mark, "Insured" and "Background checked" trust lines that disappear when the record expires). The tempting model is one mutable `provider.verified` boolean. It cannot say which proof is missing, cannot expire part of a provider, cannot keep the history an auditor needs, and would be written by whichever code last touched it.

## Decision

- **No `verified` field exists.** A provider has a **verification case**; the case holds one **requirement instance** per thing policy asks of that provider; the overall state is **derived** from the instances (`deriveStatus`, a pure function in `@bananagig/trust`). "Verification complete" means every required requirement is approved and none expired. It is not Go-Live, not the PROVIDER role and not the provider registration; the API says `goLive: { evaluated: false, eligible: false }` always, and PRO-003 will consume the `completed` signal.
- **Definition, rule and instance are separate tables.** The *definition* (stable immutable code, type from a controlled vocabulary, evidence kind, whether approvals expire) says what can be asked; the *rule* (a market and/or a service type, NULL = all) says where; the *instance* (per case, per definition, per cycle) says what this provider has to prove. Policy changes without touching history, and a requirement can be turned on for one market without code.
- **The policy snapshot is the stable definition id plus the cycle on the instance.** A policy change never edits an instance; the service adds missing instances and marks the ones policy no longer asks for `NOT_REQUIRED` the next time the case is evaluated (opening, resuming, submitting). No policy JSON is copied. An approval for a requirement policy dropped stays as visible history.
- **Re-verification is a new cycle, never an overwrite.** An approval with an end date that passes reads `EXPIRED` (derivable from the timestamp, recorded by a sweep); the provider starts `cycle + 1` of that requirement in the same case, and the expired instance, its approval, documents and reviews are kept. Within a cycle a **round** counts the provider's evidence submissions; each review and each document names its round, so decisions on stale evidence and two decisions on the same evidence are refused by the database (a unique decision per instance and round) and the service.
- **The case status is derived but stored.** It is a pure function of the instance statuses and the "submitted" fact; it is stored for the reviewers' queue and the one-live-case unique index, maintained in the same transaction as every instance change, and checked by tests. The database guards only its initial (OPEN) and terminal (CANCELLED) states. There is no REJECTED case: rejection is a requirement-level decision and the provider may resubmit (PR-02.03).
- **Expiry is per approval, not global.** `expiry_required` on the definition makes the reviewer supply the end date from the evidence; the PRD gives no validity period and none is invented.
- **Reviews are append-only with structured reason codes and no free-text notes.** A note would be sensitive text in an immutable table that can never be redacted. Reason codes are generic operational reasons (reference data with content keys); reviewers are admin identities recorded as text actors (DEBT-0046).
- **Separate roles.** `trust-read` (cases, metadata), `trust-review` (decisions and evidence links, implies read), `trust-admin` (policy only; no evidence, no decisions: separation of duties). They are client roles of the temporary model (DEBT-0021).
- **PRO-001 asks, TRUST-001 answers.** The registration's `VERIFICATION` step is answered through the existing `PrerequisitePort`; PRO-001 gains no verification state and its lifecycle does not change when verification does.

## Alternatives considered

- **A `verified` boolean (or one status) on the provider or the registration.** Rejected for the reasons above, and because it would make the registration, the role and Go-Live depend on a field written by three domains.
- **One status per case only, no instances.** Rejected: PR-02.03 needs a status and a reason per check, and expiry belongs to a requirement, not to a person.
- **Policy as configuration values.** Rejected for the taxonomy (it is reference data keyed by market and service type, like the catalogue); typed configuration is used only for the operational limits of evidence.
- **Overwriting the instance on re-verification.** Rejected: an auditor must be able to see that a provider was insured until a date and then not.
- **A REJECTED terminal case.** Rejected: PR-02.03 lets a provider fix and resubmit; a terminal state would need an appeal path nothing builds.
- **Free-text reviewer notes.** Rejected for now (privacy, retention); a note policy needs Legal (DEBT-0087).

## Consequences

- Go-Live (PRO-003) and the public profile read the derived state or consume the events; none writes it.
- Adding a requirement is data (a definition, a rule, content), not code; a new evidence kind is a new adapter.
- The market-specific acceptance of document types, requirement catalogues per region, appeals and expiry reminders are deliberately deferred (DEBT-0087, DEBT-0088).
- The case status can only be trusted because every writer goes through the service; the guards cannot recompute it (a test pins stored equals derived).

## Migration / compatibility

`0019_trust_verification.sql` adds the `trust` schema (ten tables), the guards and TRUNCATE refusals, six configuration parameters, 97 content entries and the reference seeds (four definitions of which only identity verification is active and required, seven document types, seven reason codes, one rule). It is additive: no existing table changes. Rollback is forward-fix only (`MIGRATION_POLICY.md`).

## Related files

- `db/migrations/0019_trust_verification.sql`
- `packages/contracts/src/trust.ts`
- `packages/trust/src/derive.ts`
- `packages/trust/src/service.ts`
- `apps/api/src/modules/trust/routes.ts`
- `docs/engineering/TRUST_VERIFICATION.md`
- `docs/architecture/ADR-0042-provider-registration-is-provider-domain-state-of-the-existing-account-with-derived-onboarding-steps.md`
- `docs/architecture/ADR-0040-platform-owned-taxonomy-with-stable-identities-and-status-based-retirement.md`
