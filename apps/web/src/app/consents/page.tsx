import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import {
  AcceptConsentRequest,
  CONSENT_ERROR_CODES,
  CONSENT_HISTORY_LIMIT,
  consentErrorMessageKey,
  consentEventLabelKey,
  consentPurposeLabelKey,
  consentStateLabelKey,
  consentStatusLabelKey,
  PURPOSE_CODE_PATTERN,
  type AccountConsentsDto,
  type ConsentEventDto,
  type ConsentRequirementDto,
  type ConsentRequirementsDto,
  type ResolvedContentDto,
} from '@bananagig/contracts';
import { ApiError } from '../../lib/api-client';
import { getSession, isSessionRevokedError } from '../../lib/auth/handlers';
import { authDeps } from '../../lib/auth/runtime';
import { BOOTSTRAP_COPY, getContent, getContentMany, renderContent, type ContentValue } from '../../lib/content';
import { serverApi } from '../../lib/server';

// Consent and legal-version history (ID-005). The page shows the legal text the person is asked to accept, taken from the PUBLIC content resolver, and offers Accept
// ONLY for the exact version the API says is in force: the resolver's `versionId` and `bodySha256` must equal the requirement's, otherwise the person sees the registry's
// "unavailable" note and no Accept control (what is accepted is exactly what was shown). Accepting is always an explicit POST of the person (PRD R-13): no checkbox,
// no pre-selected control, no script. Nothing in the URL is echoed except through closed lists of words; no token, no secret.
export const metadata: Metadata = { title: 'Consents', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

const key = (suffix: string): string => `account.consent.${suffix}`;
/** Largest number of requirements the page renders (the seeded purposes are two; the cap bounds the legal-text resolutions of one request). */
const MAX_REQUIREMENTS = 20;

/** `?notice=` words -> the content key of their message. Only these words are rendered; any other value is ignored. */
const NOTICE_KEYS: Readonly<Record<string, string>> = {
  accepted: key('notice.accepted'),
  withdrawn: key('notice.withdrawn'),
  already_accepted: key('notice.already_accepted'),
};
/** `?error=` values (the API codes the BFF handler relays: `ACCOUNT_<consent code>`) -> the content key of their message. */
const ERROR_KEYS: Readonly<Record<string, string>> = Object.fromEntries(CONSENT_ERROR_CODES.map((c) => [`ACCOUNT_${c}`, consentErrorMessageKey(c)]));
/** What any other error word says (the action could not be done): a generic message, never the word itself. */
const GENERIC_ERROR_KEY = key('error.unavailable');

type Loaded<T> = { ok: true; value: T } | { ok: false };

/** Runs one read; a revoked session sends the browser to /auth/revoked (which ends it), any other API failure leaves that part of the page out. */
async function load<T>(read: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (err) {
    if (isSessionRevokedError(err)) redirect('/auth/revoked');
    if (!(err instanceof ApiError)) throw err;
    return { ok: false };
  }
}

/** `2026-10-16 14:05Z`: a fixed, unambiguous rendering of an instant for the variables of the registry copy (no locale words). */
const when = (iso: string): string => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '' : `${t.toISOString().slice(0, 16).replace('T', ' ')}Z`;
};
/** The first 12 hex digits of a text hash: enough to recognise a version, never the whole value, and nothing for a malformed one. */
const shortHash = (h: string): string => (/^[0-9a-f]{64}$/.test(h) ? h.slice(0, 12) : '');
const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const validPurpose = (code: string): boolean => PURPOSE_CODE_PATTERN.test(code);

/** The purposes the person can accept now: required and not satisfied by the version in force. */
const acceptable = (r: ConsentRequirementDto): boolean => r.status === 'OUTSTANDING' || r.status === 'REACCEPTANCE_REQUIRED';

/** What the public resolver served for the version in force, once it is proven to be that very version; otherwise `unavailable`. */
type Shown = { kind: 'verified'; text: ContentValue } | { kind: 'unavailable' };

/**
 * The legal text of the version in force, from the PUBLIC resolver (no token), accepted only when it IS that version: same entry, same locale, same version id and same
 * text hash, and a well-formed accept request can be built from it. Any failure (registry down, text not served, a newer or older version served, a hash that differs)
 * is `unavailable`: the person cannot accept something they were not shown.
 */
async function showDocument(r: ConsentRequirementDto): Promise<Shown> {
  const doc = r.document;
  if (!doc) return { kind: 'unavailable' };
  if (!AcceptConsentRequest.safeParse({ versionId: doc.versionId, locale: doc.locale, bodySha256: doc.bodySha256 }).success) return { kind: 'unavailable' };
  let resolved: ResolvedContentDto;
  try {
    resolved = await serverApi().resolveContent({ key: doc.entryKey, locale: doc.locale });
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return { kind: 'unavailable' };
  }
  const same =
    resolved.key === doc.entryKey &&
    resolved.contentType === 'LEGAL' &&
    resolved.resolvedLocale === doc.locale &&
    resolved.versionId === doc.versionId &&
    resolved.bodySha256 === doc.bodySha256 &&
    resolved.value.length > 0;
  return same ? { kind: 'verified', text: { format: resolved.format, value: resolved.value } } : { kind: 'unavailable' };
}

interface SearchParams {
  notice?: string | string[];
  error?: string | string[];
}

export default async function ConsentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const session = await getSession((await headers()).get('cookie'), authDeps());
  if (!session) {
    const copy = await getContentMany([key('title'), 'common.action.sign_in']);
    const title = renderContent(copy[key('title')]);
    return (
      <>
        {title ? <h1>{title}</h1> : null}
        <p>
          <a href="/auth/login?returnTo=/consents">{renderContent(copy['common.action.sign_in']) ?? BOOTSTRAP_COPY.signIn}</a>
        </p>
      </>
    );
  }

  const api = serverApi(session.record.accessToken);
  const o = { activeRole: session.record.activeRole };
  const [requirements, consents] = await Promise.all([
    load<ConsentRequirementsDto>(() => api.getConsentRequirements({}, o)),
    load<AccountConsentsDto>(() => api.getAccountConsents(o)),
  ]);

  const rows = requirements.ok ? requirements.value.requirements.filter((r) => validPurpose(r.purposeCode)).slice(0, MAX_REQUIREMENTS) : [];
  const history: ConsentEventDto[] = consents.ok ? consents.value.history.slice(0, CONSENT_HISTORY_LIMIT) : [];
  // the legal text of every purpose the person can accept now, each proven to be the version in force (in parallel; at most MAX_REQUIREMENTS resolutions)
  const shown = new Map<string, Shown>(await Promise.all(rows.filter(acceptable).map(async (r) => [r.purposeCode, await showDocument(r)] as const)));
  const unavailableNote = (r: ConsentRequirementDto): boolean => r.status === 'DOCUMENT_UNAVAILABLE' || shown.get(r.purposeCode)?.kind === 'unavailable';
  const canWithdraw = (r: ConsentRequirementDto): boolean => r.withdrawable && r.acceptanceState === 'ACCEPTED' && !r.required;

  // a notice is only shown when the data proves what it claims (the words in the URL can be typed by anyone): "accepted" needs an acceptance, "withdrawn" a withdrawal
  const proof: Readonly<Record<string, boolean>> = {
    accepted: rows.some((r) => r.acceptanceState === 'ACCEPTED'),
    already_accepted: rows.some((r) => r.acceptanceState === 'ACCEPTED'),
    withdrawn: rows.some((r) => r.acceptanceState === 'WITHDRAWN'),
  };
  const noticeWord = one(query.notice);
  const noticeKey = noticeWord !== undefined && Object.hasOwn(NOTICE_KEYS, noticeWord) && proof[noticeWord] ? NOTICE_KEYS[noticeWord] : undefined;
  const errorWord = one(query.error);
  const errorKey = errorWord !== undefined ? (Object.hasOwn(ERROR_KEYS, errorWord) ? ERROR_KEYS[errorWord] : GENERIC_ERROR_KEY) : undefined;
  const everythingDown = !requirements.ok && !consents.ok;

  const satisfied = requirements.ok ? requirements.value.satisfied : false;
  const anyAccept = rows.some((r) => shown.get(r.purposeCode)?.kind === 'verified');
  const anyWithdraw = rows.some(canWithdraw);
  const copy = await getContentMany([
    key('title'),
    key('intro'),
    ...(noticeKey ? [noticeKey] : []),
    ...(errorKey ? [errorKey] : everythingDown ? [GENERIC_ERROR_KEY] : []),
    ...(requirements.ok ? [key('requirements.title'), satisfied ? key('requirements.all_done') : key('requirements.outstanding_intro')] : []),
    ...rows.flatMap((r) => [consentPurposeLabelKey(r.purposeCode), consentStatusLabelKey(r.status), consentStateLabelKey(r.acceptanceState)]),
    ...(rows.some(unavailableNote) ? [key('document.unavailable_note')] : []),
    ...(anyAccept ? [key('document.read'), key('action.accept')] : []),
    ...(anyWithdraw ? [key('action.withdraw')] : []),
    ...(consents.ok ? [key('history.title'), ...(history.length === 0 ? [key('history.empty')] : [])] : []),
    ...history.flatMap((e) => [consentPurposeLabelKey(e.purposeCode), consentEventLabelKey(e.eventType)]),
  ]);
  const text = (k: string) => renderContent(copy[k]);

  // copy with a variable is resolved once per distinct value (the batch call takes one set of variables per key), all up front: a rendering function cannot await
  const versionVars = (n: number) => ({ id: `version:${n}`, k: key('document.version'), variables: { version: n } });
  const localeVars = (l: string) => ({ id: `locale:${l}`, k: key('document.locale'), variables: { locale: l } });
  const acceptedOnVars = (iso: string) => ({ id: `on:${when(iso)}`, k: key('accepted_on'), variables: { date: when(iso) } });
  const wanted = [
    ...rows.flatMap((r) => {
      const d = shown.get(r.purposeCode)?.kind === 'verified' ? r.document : null;
      return [
        ...(d ? [versionVars(d.version), localeVars(d.locale)] : []),
        ...(r.accepted && r.acceptanceState === 'ACCEPTED' ? [versionVars(r.accepted.document.version), acceptedOnVars(r.accepted.occurredAt)] : []),
      ];
    }),
    ...history.flatMap((e) => [versionVars(e.document.version), localeVars(e.document.locale)]),
  ];
  const distinct = [...new Map(wanted.map((w) => [w.id, w])).values()];
  const withVariables = new Map(
    await Promise.all(distinct.map(async (w) => [w.id, renderContent(await getContent(w.k, { variables: w.variables }))] as const)),
  );
  const vText = (w: { id: string }) => withVariables.get(w.id) ?? null;

  const notice = noticeKey ? text(noticeKey) : null;
  const failure = errorKey ? text(errorKey) : everythingDown ? text(GENERIC_ERROR_KEY) : null;
  const title = text(key('title'));
  const intro = text(key('intro'));

  return (
    <>
      {title ? <h1>{title}</h1> : null}
      {failure ? <p role="alert">{failure}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {intro ? <p>{intro}</p> : null}

      {requirements.ok && text(key('requirements.title')) ? (
        <section aria-labelledby="consent-requirements">
          <h2 id="consent-requirements">{text(key('requirements.title'))}</h2>
          {text(satisfied ? key('requirements.all_done') : key('requirements.outstanding_intro')) ? (
            <p>{text(satisfied ? key('requirements.all_done') : key('requirements.outstanding_intro'))}</p>
          ) : null}
          <ul>
            {rows.map((r) => {
              const label = text(consentPurposeLabelKey(r.purposeCode));
              const verified = shown.get(r.purposeCode);
              const doc = r.document;
              const acceptedAt = r.accepted && r.acceptanceState === 'ACCEPTED' ? r.accepted : null;
              const state = text(consentStateLabelKey(r.acceptanceState));
              const status = text(consentStatusLabelKey(r.status));
              return (
                <li key={r.purposeCode}>
                  {label ? <h3>{label}</h3> : null}
                  {status ? <p>{status}</p> : null}
                  {state || acceptedAt ? (
                    <p>
                      {state}
                      {acceptedAt && vText(acceptedOnVars(acceptedAt.occurredAt)) ? <> {vText(acceptedOnVars(acceptedAt.occurredAt))}</> : null}
                      {acceptedAt && vText(versionVars(acceptedAt.document.version)) ? <> {vText(versionVars(acceptedAt.document.version))}</> : null}
                    </p>
                  ) : null}
                  {unavailableNote(r) && text(key('document.unavailable_note')) ? <p role="status">{text(key('document.unavailable_note'))}</p> : null}
                  {verified?.kind === 'verified' && doc ? (
                    <>
                      <p>
                        {vText(versionVars(doc.version))} {vText(localeVars(doc.locale))}
                      </p>
                      {text(key('document.read')) ? <h4 id={`consent-doc-${r.purposeCode}`}>{text(key('document.read'))}</h4> : null}
                      <div
                        lang={doc.locale}
                        className={verified.text.format === 'text' ? 'legal-text' : undefined}
                        {...(text(key('document.read')) ? { role: 'region', 'aria-labelledby': `consent-doc-${r.purposeCode}` } : {})}
                      >
                        {renderContent(verified.text)}
                      </div>
                      {/* the hidden fields are the version that was just PROVEN to be the one shown; the server verifies them again. No checkbox, nothing pre-selected. */}
                      {text(key('action.accept')) ? (
                        <form method="post" action="/auth/consents/accept">
                          <input type="hidden" name="purpose" value={r.purposeCode} />
                          <input type="hidden" name="versionId" value={doc.versionId} />
                          <input type="hidden" name="locale" value={doc.locale} />
                          <input type="hidden" name="bodySha256" value={doc.bodySha256} />
                          <button type="submit">{text(key('action.accept'))}</button>
                        </form>
                      ) : null}
                    </>
                  ) : null}
                  {canWithdraw(r) && text(key('action.withdraw')) ? (
                    <form method="post" action="/auth/consents/withdraw">
                      <input type="hidden" name="purpose" value={r.purposeCode} />
                      <button type="submit">{text(key('action.withdraw'))}</button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {consents.ok && text(key('history.title')) ? (
        <section aria-labelledby="consent-history">
          <h2 id="consent-history">{text(key('history.title'))}</h2>
          {history.length === 0 ? (
            text(key('history.empty')) ? (
              <p>{text(key('history.empty'))}</p>
            ) : null
          ) : (
            <ul>
              {history.map((e) => (
                <li key={e.consentEventId}>
                  {text(consentPurposeLabelKey(e.purposeCode)) ? <span>{text(consentPurposeLabelKey(e.purposeCode))}</span> : null}{' '}
                  {text(consentEventLabelKey(e.eventType)) ? <span>{text(consentEventLabelKey(e.eventType))}</span> : null}{' '}
                  {vText(versionVars(e.document.version)) ? <span>{vText(versionVars(e.document.version))}</span> : null}{' '}
                  {vText(localeVars(e.document.locale)) ? <span>{vText(localeVars(e.document.locale))}</span> : null}{' '}
                  <time dateTime={e.occurredAt}>{when(e.occurredAt)}</time>
                  {shortHash(e.document.bodySha256) ? (
                    <>
                      {' '}
                      <code>{shortHash(e.document.bodySha256)}</code>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </>
  );
}
