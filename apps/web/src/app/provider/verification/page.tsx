import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { TRUST_ERROR_CODES, trustErrorKey, type ProviderVerificationDto, type TrustErrorCode, type VerificationRequirementDto } from '@bananagig/contracts';
import { ApiError } from '../../../lib/api-client';
import { getSession, isSessionRevokedError } from '../../../lib/auth/handlers';
import { authDeps } from '../../../lib/auth/runtime';
import { BOOTSTRAP_COPY, getContentMany, renderContent } from '../../../lib/content';
import { serverApi } from '../../../lib/server';

// Provider verification (TRUST-001): a deliberately MINIMAL, temporary flow so a signed-in provider can see what is asked, add a document for a requirement, remove a draft, submit,
// start again after an expiry, and read the outcome (with the reviewer's reason). It decides nothing: every status shown is what the API derived, Submit is only OFFERED when
// every requirement waiting for the provider has a draft document (the server decides again), and there is NO download of evidence and no control that approves anything. All
// user-visible text is registry copy (`trust.*`); nothing is hardcoded. Approved verification is NOT "live" and the page says so. No script; nothing in the URL is echoed except
// through closed lists of words.
export const metadata: Metadata = { title: 'Verification', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

const page = (suffix: string): string => `trust.verification.page.${suffix}`;
const ERROR_KEYS: Readonly<Record<string, string>> = Object.fromEntries(TRUST_ERROR_CODES.map((c) => [`TRUST_${c}`, trustErrorKey(c as TrustErrorCode)]));
/** What any other error word says: the generic "unavailable" message of the registry, never the word itself. */
const GENERIC_ERROR_KEY = trustErrorKey('UNAVAILABLE');
const NOTICE_KEYS: Readonly<Record<string, string>> = {
  uploaded: page('uploaded_notice'),
  withdrawn: page('withdrawn_notice'),
  submitted: page('submitted_notice'),
  cancelled: page('cancelled_notice'),
};
/** The file types the file picker offers (the server checks the type again against the configured list and the file's own signature). */
const ACCEPT = 'application/pdf,image/jpeg,image/png';

type Loaded<T> = { ok: true; value: T } | { ok: false };
async function load<T>(read: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (err) {
    if (isSessionRevokedError(err)) redirect('/auth/revoked');
    if (!(err instanceof ApiError)) throw err;
    return { ok: false };
  }
}
const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
/** `2026-10-17`: a fixed, unambiguous rendering of a date (no locale words). */
const day = (iso: string): string => (Number.isNaN(new Date(iso).getTime()) ? '' : new Date(iso).toISOString().slice(0, 10));

interface SearchParams {
  notice?: string | string[];
  error?: string | string[];
}

export default async function ProviderVerificationPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const session = await getSession((await headers()).get('cookie'), authDeps());
  if (!session) {
    const copy = await getContentMany([page('title'), 'common.action.sign_in']);
    const title = renderContent(copy[page('title')]);
    return (
      <>
        {title ? <h1>{title}</h1> : null}
        <p>
          <a href="/auth/login?returnTo=/provider/verification">{renderContent(copy['common.action.sign_in']) ?? BOOTSTRAP_COPY.signIn}</a>
        </p>
      </>
    );
  }

  const api = serverApi(session.record.accessToken);
  const o = { activeRole: session.record.activeRole };
  const result = await load<ProviderVerificationDto>(() => api.getProviderVerification(o));
  const v = result.ok ? result.value : null;
  const requirements: VerificationRequirementDto[] = v ? v.requirements : [];
  const caseRow = v?.case ?? null;
  const cancellable = caseRow !== null && ['OPEN', 'IN_REVIEW', 'ACTION_REQUIRED'].includes(caseRow.status);
  const waiting = requirements.filter((r) => r.canAttachEvidence);
  const submittable = caseRow !== null && waiting.length > 0 && waiting.every((r) => r.documents.some((x) => x.status === 'ATTACHED'));

  const noticeWord = one(query.notice);
  // a notice is only shown when the data proves what it claims (the words in the URL can be typed by anyone)
  const noticeKey =
    noticeWord !== undefined &&
    Object.hasOwn(NOTICE_KEYS, noticeWord) &&
    v !== null &&
    (noticeWord !== 'cancelled' || caseRow === null) &&
    (noticeWord !== 'submitted' || caseRow?.submittedAt)
      ? NOTICE_KEYS[noticeWord]
      : undefined;
  const errorWord = one(query.error);
  const errorKey = errorWord !== undefined ? (Object.hasOwn(ERROR_KEYS, errorWord) ? ERROR_KEYS[errorWord] : GENERIC_ERROR_KEY) : undefined;

  const copy = await getContentMany([
    page('title'),
    page('intro'),
    ...(noticeKey ? [noticeKey] : []),
    ...(errorKey ? [errorKey] : !result.ok ? [GENERIC_ERROR_KEY] : []),
    ...(v
      ? [
          v.overall.statusKey,
          page('status_label'),
          page('golive_note'),
          ...(v.requirements.length === 0 ? [page('empty_requirements')] : [page('requirements_heading')]),
          ...(!v.prerequisiteMet ? [page('prerequisite_hint')] : []),
          ...(caseRow === null && v.prerequisiteMet && v.overall.requiredCount > 0 ? [page('open_action')] : []),
          ...(submittable ? [page('submit_action')] : []),
          ...(cancellable ? [page('cancel_action')] : []),
        ]
      : []),
    ...requirements.flatMap((r) => [
      r.nameKey,
      r.instructionsKey,
      r.statusKey,
      ...(r.reasonKey ? [r.reasonKey, page('reason_label')] : []),
      ...(r.expiresAt ? [page('valid_until_label')] : []),
      ...(r.canReverify ? [page('reverify_action')] : []),
      ...(r.canAttachEvidence
        ? [
            page('upload_heading'),
            page('document_type_label'),
            page('file_label'),
            page('file_help'),
            page('upload_action'),
            ...r.documentTypes.map((t) => t.nameKey),
          ]
        : []),
      ...r.documents.flatMap((d) => [
        d.documentTypeNameKey,
        d.statusKey,
        d.scanStatusKey,
        ...(d.status === 'ATTACHED' || d.status === 'UPLOAD_PENDING' ? [page('withdraw_action')] : []),
      ]),
      ...(r.documents.length > 0 ? [page('documents_heading')] : []),
    ]),
  ]);
  const text = (k: string) => renderContent(copy[k]);
  const failure = errorKey ? text(errorKey) : !result.ok ? text(GENERIC_ERROR_KEY) : null;
  const notice = noticeKey ? text(noticeKey) : null;
  const title = text(page('title'));
  const intro = text(page('intro'));
  const errorId = 'verification-error';
  const describedBy = failure ? { 'aria-describedby': errorId } : {};

  return (
    <div className="provider-registration">
      {title ? <h1>{title}</h1> : null}
      {failure ? (
        <p id={errorId} role="alert">
          {failure}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {intro ? <p>{intro}</p> : null}

      {v ? (
        <>
          {text(v.overall.statusKey) ? (
            <p>
              {text(page('status_label')) ? <strong>{text(page('status_label'))}: </strong> : null}
              {text(v.overall.statusKey)}
            </p>
          ) : null}
          {!v.prerequisiteMet && text(page('prerequisite_hint')) ? (
            <p>
              <a href="/provider/registration">{text(page('prerequisite_hint'))}</a>
            </p>
          ) : null}
          {caseRow === null && v.prerequisiteMet && v.overall.requiredCount > 0 && text(page('open_action')) ? (
            <form method="post" action="/auth/provider/verification/open" {...describedBy}>
              <button type="submit">{text(page('open_action'))}</button>
            </form>
          ) : null}

          {requirements.length === 0 ? (
            text(page('empty_requirements')) ? (
              <p>{text(page('empty_requirements'))}</p>
            ) : null
          ) : (
            <section aria-labelledby="verification-requirements">
              {text(page('requirements_heading')) ? <h2 id="verification-requirements">{text(page('requirements_heading'))}</h2> : null}
              <ul>
                {requirements.map((r) => (
                  <li key={r.requirementCode}>
                    {text(r.nameKey) ? <h3>{text(r.nameKey)}</h3> : null}
                    {text(r.instructionsKey) ? <p>{text(r.instructionsKey)}</p> : null}
                    <p>
                      {text(page('status_label')) ? <strong>{text(page('status_label'))}: </strong> : null}
                      {text(r.statusKey)}
                      {r.expiresAt && text(page('valid_until_label')) ? ` (${text(page('valid_until_label'))} ${day(r.expiresAt)})` : ''}
                    </p>
                    {r.reasonKey && text(r.reasonKey) ? (
                      <p role="note">
                        {text(page('reason_label')) ? <strong>{text(page('reason_label'))}: </strong> : null}
                        {text(r.reasonKey)}
                      </p>
                    ) : null}

                    {r.documents.length > 0 ? (
                      <>
                        {text(page('documents_heading')) ? <h4>{text(page('documents_heading'))}</h4> : null}
                        <ul>
                          {r.documents.map((d) => (
                            <li key={d.verificationDocumentId}>
                              {text(d.documentTypeNameKey)} {text(d.statusKey)} {text(d.scanStatusKey)}
                              {(d.status === 'ATTACHED' || d.status === 'UPLOAD_PENDING') && text(page('withdraw_action')) ? (
                                <form method="post" action="/auth/provider/verification/withdraw" {...describedBy}>
                                  <input type="hidden" name="documentId" value={d.verificationDocumentId} />
                                  <button type="submit">{text(page('withdraw_action'))}</button>
                                </form>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}

                    {r.canAttachEvidence &&
                    r.evidenceKind === 'DOCUMENT' &&
                    text(page('document_type_label')) &&
                    text(page('file_label')) &&
                    text(page('upload_action')) ? (
                      <form method="post" action="/auth/provider/verification/upload" encType="multipart/form-data" {...describedBy}>
                        {text(page('upload_heading')) ? <h4>{text(page('upload_heading'))}</h4> : null}
                        <input type="hidden" name="requirementCode" value={r.requirementCode} />
                        <p>
                          <label htmlFor={`type-${r.requirementCode}`}>{text(page('document_type_label'))}</label>
                          <select id={`type-${r.requirementCode}`} name="documentTypeCode" required>
                            {r.documentTypes.map((t) => (
                              <option key={t.code} value={t.code}>
                                {text(t.nameKey)}
                              </option>
                            ))}
                          </select>
                        </p>
                        <p>
                          <label htmlFor={`file-${r.requirementCode}`}>{text(page('file_label'))}</label>
                          <input
                            id={`file-${r.requirementCode}`}
                            name="file"
                            type="file"
                            accept={ACCEPT}
                            required
                            {...(text(page('file_help')) ? { 'aria-describedby': `file-help-${r.requirementCode}` } : {})}
                          />
                        </p>
                        {text(page('file_help')) ? <p id={`file-help-${r.requirementCode}`}>{text(page('file_help'))}</p> : null}
                        {text(page('upload_action')) ? <button type="submit">{text(page('upload_action'))}</button> : null}
                      </form>
                    ) : null}

                    {r.canReverify && text(page('reverify_action')) ? (
                      <form method="post" action="/auth/provider/verification/reverify" {...describedBy}>
                        <input type="hidden" name="requirementCode" value={r.requirementCode} />
                        <button type="submit">{text(page('reverify_action'))}</button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {submittable && caseRow && text(page('submit_action')) ? (
            <form method="post" action="/auth/provider/verification/submit" {...describedBy}>
              <input type="hidden" name="expectedRevision" value={caseRow.revision} />
              <button type="submit">{text(page('submit_action'))}</button>
            </form>
          ) : null}
          {cancellable && text(page('cancel_action')) ? (
            <form method="post" action="/auth/provider/verification/cancel" {...describedBy}>
              <button type="submit">{text(page('cancel_action'))}</button>
            </form>
          ) : null}
          {text(page('golive_note')) ? <p>{text(page('golive_note'))}</p> : null}
        </>
      ) : null}
    </div>
  );
}
