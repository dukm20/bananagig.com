// Pure validation of the provider profile text (PRO-002): the display name (single line) and the bio (multi-line), both PLAIN TEXT normalised with the CAT-003 normaliser. No database, no
// ports, no clock. Every result is an identifier (field, reason); the provider's own text never appears in an issue.
import { normalizeProviderText, textLength, type ProfileIssueDto, type ProfileIssueReason, type ProviderProfilePolicy } from '@bananagig/contracts';

export type ProfileTextField = 'displayName' | 'bio';

const REASONS: Record<ProfileTextField, { tooLong: ProfileIssueReason; blank: ProfileIssueReason; forbidden: ProfileIssueReason; html: ProfileIssueReason }> = {
  displayName: {
    tooLong: 'DISPLAY_NAME_TOO_LONG',
    blank: 'DISPLAY_NAME_BLANK',
    forbidden: 'DISPLAY_NAME_FORBIDDEN_CHARACTER',
    html: 'DISPLAY_NAME_HTML_NOT_ALLOWED',
  },
  bio: { tooLong: 'BIO_TOO_LONG', blank: 'BIO_BLANK', forbidden: 'BIO_FORBIDDEN_CHARACTER', html: 'BIO_HTML_NOT_ALLOWED' },
};

// A person must be able to SEE something: at least one letter, number, symbol or punctuation mark that is not a default-ignorable code point and not a Hangul filler or the blank
// braille pattern. Marks, variation selectors, joiners and fillers alone are blank-looking (the shared normaliser accepts them; this profile-level check does not).
const BLANK_LOOKING = /[\u115F\u1160\u3164\uFFA0\u2800]/u;
const BASE_VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
export function hasVisibleBase(text: string): boolean {
  for (const ch of text) if (BASE_VISIBLE.test(ch) && !DEFAULT_IGNORABLE.test(ch) && !BLANK_LOOKING.test(ch)) return true;
  return false;
}

export type TextCheck = { ok: true; value: string | null } | { ok: false; issue: ProfileIssueDto };

/**
 * One text field. `null` clears it; a string is normalised (NFC, outer whitespace trimmed; the display name is also collapsed to one line) and must have visible content, be free of
 * control, bidirectional-override and invisible characters and of HTML-looking markup, and be at most the configured length in code points.
 */
export function checkProfileText(field: ProfileTextField, raw: string | null, policy: ProviderProfilePolicy): TextCheck {
  if (raw === null) return { ok: true, value: null };
  const reasons = REASONS[field];
  const n = normalizeProviderText(raw, { multiline: field === 'bio' });
  const issue = (reason: ProfileIssueReason): TextCheck => ({ ok: false, issue: { reason, field } });
  if (!n.ok) return issue(n.reason === 'HTML_NOT_ALLOWED' ? reasons.html : reasons.forbidden);
  if (n.value === '' || !hasVisibleBase(n.value)) return issue(reasons.blank);
  const max = field === 'displayName' ? policy.displayNameMaxLength : policy.bioMaxLength;
  if (textLength(n.value) > max) return issue(reasons.tooLong);
  return { ok: true, value: n.value };
}

/** The validated change of an update request: only the fields the request named (an absent field stays unchanged). */
export interface ProfileTextChange {
  displayName?: string | null;
  bio?: string | null;
}
export function validateProfileUpdate(
  body: { displayName?: string | null | undefined; bio?: string | null | undefined },
  policy: ProviderProfilePolicy,
): { ok: true; change: ProfileTextChange } | { ok: false; issues: ProfileIssueDto[] } {
  const change: ProfileTextChange = {};
  const issues: ProfileIssueDto[] = [];
  for (const field of ['displayName', 'bio'] as const) {
    const raw = body[field];
    if (raw === undefined) continue;
    const r = checkProfileText(field, raw, policy);
    if (r.ok) change[field] = r.value;
    else issues.push(r.issue);
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, change };
}

/** What a PUBLIC profile still needs (identifiers only), from the stored facts and the configured requirements. */
export function publishingIssues(
  facts: { publicNameAvailable: boolean; bioPresent: boolean; photoPresent: boolean },
  policy: ProviderProfilePolicy,
): ProfileIssueDto[] {
  const issues: ProfileIssueDto[] = [];
  if (!facts.publicNameAvailable) issues.push({ reason: 'PUBLIC_NAME_UNAVAILABLE', field: 'displayName' });
  if (policy.bioRequired && !facts.bioPresent) issues.push({ reason: 'BIO_REQUIRED', field: 'bio' });
  if (policy.photoRequired && !facts.photoPresent) issues.push({ reason: 'PHOTO_REQUIRED', field: 'photo' });
  return issues;
}
