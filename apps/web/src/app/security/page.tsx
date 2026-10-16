import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import {
  browserLabelKey,
  deviceClassLabelKey,
  osLabelKey,
  securityActivityLabelKey,
  type DeviceSummaryDto,
  type SecurityActivityDto,
  type SecurityDevicesDto,
  type SecurityOverviewDto,
  type SecuritySessionsDto,
} from '@bananagig/contracts';
import { ApiError } from '../../lib/api-client';
import { getSession, isSessionRevokedError } from '../../lib/auth/handlers';
import { authDeps } from '../../lib/auth/runtime';
import { BOOTSTRAP_COPY, getContent, getContentMany, renderContent } from '../../lib/content';
import { serverApi } from '../../lib/server';

// The page carries no secret and no token: only opaque ids in hidden form fields and registry copy. Nothing in the URL is echoed except through a closed list of words.
export const metadata: Metadata = { title: 'Security', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

const key = (suffix: string): string => `account.security.${suffix}`;
/** Largest number of rows each list renders (the API pages its own lists). */
const MAX_ROWS = 50;

/** `?notice=` words -> the content key of their message. Only these words are rendered; any other value is ignored. */
const NOTICE_KEYS: Readonly<Record<string, string>> = {
  session_revoked: key('notice.session_revoked'),
  signed_out_elsewhere: key('notice.signed_out_elsewhere'),
  device_trusted: key('notice.device_trusted'),
  device_untrusted: key('notice.device_untrusted'),
  device_removed: key('notice.device_removed'),
  mfa_return_success: key('notice.mfa_return_success'),
  mfa_return_cancelled: key('notice.mfa_return_cancelled'),
};
/** `?error=` values (the words of the callback, the API error codes of the BFF handlers) -> the content key of their message. */
const ERROR_KEYS: Readonly<Record<string, string>> = {
  step_up_required: key('error.step_up_required'),
  session_revoked: key('error.session_revoked'),
  STEP_UP_REQUIRED: key('error.step_up_required'),
  SESSION_REVOKED: key('error.session_revoked'),
  MFA_ENROLLMENT_REQUIRED: key('error.mfa_enrollment_required'),
  ACCOUNT_SESSION_NOT_FOUND: key('error.session_not_found'),
  ACCOUNT_DEVICE_NOT_FOUND: key('error.device_not_found'),
  ACCOUNT_DEVICE_REQUIRED: key('error.device_required'),
  ACCOUNT_SECURITY_UNAVAILABLE: key('error.security_unavailable'),
};
/** What an error word the page does not know says (the API could not do it): the generic "unavailable" message, never the word itself. */
const GENERIC_ERROR_KEY = key('error.security_unavailable');
/** The outcomes Keycloak reports for an action the person started there, as relayed by the callback (`kc_action_status`). */
const KC_STATUS_NOTICE: Readonly<Record<string, string>> = { success: NOTICE_KEYS.mfa_return_success!, cancelled: NOTICE_KEYS.mfa_return_cancelled! };

type Loaded<T> = { ok: true; value: T } | { ok: false };

/** Runs one read; a revoked session sends the browser to /auth/revoked (which ends it), any other failure leaves that part of the page out. */
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
const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const deviceKeys = (d: DeviceSummaryDto | null): string[] => (d ? [browserLabelKey(d.browser), osLabelKey(d.os), deviceClassLabelKey(d.deviceClass)] : []);

interface SearchParams {
  notice?: string | string[];
  error?: string | string[];
  kc_action_status?: string | string[];
}

// Account security (S-09): second factor, signed-in sessions, browsers (the trusted-browser window) and the activity timeline. Every string comes from the managed
// content registry; one the registry cannot serve is omitted (never replaced by a literal), except the sign-in and sign-out controls.
export default async function SecurityPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const session = await getSession((await headers()).get('cookie'), authDeps());
  if (!session) {
    const copy = await getContentMany([key('title'), 'common.action.sign_in']);
    const title = renderContent(copy[key('title')]);
    return (
      <>
        {title ? <h1>{title}</h1> : null}
        <p>
          <a href="/auth/login?returnTo=/security">{renderContent(copy['common.action.sign_in']) ?? BOOTSTRAP_COPY.signIn}</a>
        </p>
      </>
    );
  }

  const api = serverApi(session.record.accessToken);
  const o = { activeRole: session.record.activeRole };
  const [overview, sessions, devices, activity] = await Promise.all([
    load<SecurityOverviewDto>(() => api.getSecurityOverview(o)),
    load<SecuritySessionsDto>(() => api.listSecuritySessions(o)),
    load<SecurityDevicesDto>(() => api.listSecurityDevices(o)),
    load<SecurityActivityDto>(() => api.listSecurityActivity({}, o)),
  ]);

  const activeSessions = sessions.ok ? sessions.value.sessions.filter((s) => s.status === 'ACTIVE').slice(0, MAX_ROWS) : [];
  const deviceList = devices.ok ? devices.value.devices.slice(0, MAX_ROWS) : [];
  const entries = activity.ok ? activity.value.entries.slice(0, MAX_ROWS) : [];

  // which message to show: an error wins over a notice; unknown words are ignored (an unknown ERROR word is the generic "unavailable", never echoed)
  const errorWord = one(query.error);
  const noticeWord = one(query.notice);
  const kcStatus = one(query.kc_action_status);
  // "second factor set up" is only claimed when the overview says a factor IS configured: the words in the URL (a notice or the callback's kc_action_status) can be
  // typed by anyone. Without that proof nothing is shown for them (the cancelled notice needs no proof: it claims nothing).
  const factorConfigured = Boolean(
    overview.ok && overview.value.mfa.available && (overview.value.mfa.totpConfigured || overview.value.mfa.recoveryCodesConfigured),
  );
  const proven = (k: string | undefined): string | undefined => (k === NOTICE_KEYS.mfa_return_success && !factorConfigured ? undefined : k);
  const noticeKey = proven(
    noticeWord !== undefined && Object.hasOwn(NOTICE_KEYS, noticeWord)
      ? NOTICE_KEYS[noticeWord]
      : kcStatus !== undefined && Object.hasOwn(KC_STATUS_NOTICE, kcStatus)
        ? KC_STATUS_NOTICE[kcStatus]
        : undefined,
  );
  const errorKey =
    errorWord !== undefined
      ? Object.hasOwn(ERROR_KEYS, errorWord)
        ? ERROR_KEYS[errorWord]
        : GENERIC_ERROR_KEY
      : kcStatus === 'error'
        ? GENERIC_ERROR_KEY
        : undefined;
  const everythingDown = !overview.ok && !sessions.ok && !devices.ok && !activity.ok;

  const mfa = overview.ok ? overview.value.mfa : undefined;
  const mfaState = (configured: boolean): string => key(`mfa.status.${mfa?.available ? (configured ? 'enabled' : 'disabled') : 'unknown'}`);
  const labelKeys = new Set<string>([
    ...activeSessions.flatMap((s) => deviceKeys(s.device)),
    ...deviceList.flatMap((d) => deviceKeys(d.device)),
    ...entries.flatMap((e) => deviceKeys(e.device)),
    ...entries.map((e) => securityActivityLabelKey(e.type)),
  ]);
  const copy = await getContentMany([
    key('title'),
    'common.action.sign_out',
    key('sessions.sign_out_everywhere'),
    ...(noticeKey ? [noticeKey] : []),
    ...(errorKey ? [errorKey] : everythingDown ? [GENERIC_ERROR_KEY] : []),
    ...(overview.ok
      ? [
          key('mfa.title'),
          key('mfa.totp.label'),
          key('mfa.recovery.label'),
          mfaState(mfa!.totpConfigured),
          mfaState(mfa!.recoveryCodesConfigured),
          key('mfa.stepup_note'),
          ...(mfa!.available ? [key('mfa.totp.enable'), key('mfa.recovery.generate'), key('mfa.recovery.warning')] : []),
        ]
      : []),
    ...(sessions.ok ? [key('sessions.title'), key('sessions.current'), key('sessions.sign_out'), key('sessions.empty'), key('sessions.unreconciled')] : []),
    ...(devices.ok
      ? [
          key('devices.title'),
          key('devices.trust'),
          key('devices.untrust'),
          key('devices.remove'),
          key('devices.trust_note'),
          key('devices.none'),
          key('sessions.current'),
        ]
      : []),
    ...(activity.ok ? [key('activity.title'), key('activity.empty')] : []),
    ...labelKeys,
  ]);
  const text = (k: string) => renderContent(copy[k]);

  // copy with a variable is resolved once per distinct value (the batch call takes one set of variables per key)
  const whens = [...new Set(activeSessions.map((s) => when(s.lastSeenAt)).filter(Boolean))];
  const dates = [...new Set(deviceList.flatMap((d) => (d.trusted && d.trustedUntil ? [when(d.trustedUntil)] : [])).filter(Boolean))];
  const [lastSeenBy, trustedUntilBy] = await Promise.all([
    Promise.all(whens.map(async (w) => [w, await getContent(key('sessions.last_seen'), { variables: { when: w } })] as const)).then((e) => new Map(e)),
    Promise.all(dates.map(async (w) => [w, await getContent(key('devices.trusted_until'), { variables: { date: w } })] as const)).then((e) => new Map(e)),
  ]);

  // the coarse labels are plain text values; a label the registry cannot serve (or serves as markup) is left out of the line
  const plain = (k: string): string | undefined => (copy[k]?.format === 'text' ? copy[k]!.value : undefined);
  const deviceLine = (d: DeviceSummaryDto | null): string =>
    d ? [plain(browserLabelKey(d.browser)), plain(osLabelKey(d.os)), plain(deviceClassLabelKey(d.deviceClass))].filter(Boolean).join(' · ') : '';
  const signOut = text('common.action.sign_out') ?? BOOTSTRAP_COPY.signOut;
  const notice = noticeKey ? text(noticeKey) : null;
  const failure = errorKey ? text(errorKey) : everythingDown ? text(GENERIC_ERROR_KEY) : null;
  const title = text(key('title'));
  const currentLabel = text(key('sessions.current'));

  return (
    <>
      {title ? <h1>{title}</h1> : null}
      {failure ? <p role="alert">{failure}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}

      {mfa && text(key('mfa.title')) ? (
        <section aria-labelledby="security-mfa">
          <h2 id="security-mfa">{text(key('mfa.title'))}</h2>
          <dl>
            {text(key('mfa.totp.label')) ? (
              <>
                <dt>{text(key('mfa.totp.label'))}</dt>
                <dd>{text(mfaState(mfa.totpConfigured))}</dd>
              </>
            ) : null}
            {text(key('mfa.recovery.label')) ? (
              <>
                <dt>{text(key('mfa.recovery.label'))}</dt>
                <dd>{text(mfaState(mfa.recoveryCodesConfigured))}</dd>
              </>
            ) : null}
          </dl>
          {mfa.available && !mfa.totpConfigured && text(key('mfa.totp.enable')) ? (
            <form method="post" action="/auth/security/mfa-enroll">
              <input type="hidden" name="method" value="TOTP" />
              <button type="submit">{text(key('mfa.totp.enable'))}</button>
            </form>
          ) : null}
          {mfa.available && text(key('mfa.recovery.generate')) ? (
            <form method="post" action="/auth/security/mfa-enroll">
              <input type="hidden" name="method" value="RECOVERY_CODES" />
              <button type="submit">{text(key('mfa.recovery.generate'))}</button>
              {text(key('mfa.recovery.warning')) ? <p>{text(key('mfa.recovery.warning'))}</p> : null}
            </form>
          ) : null}
          {text(key('mfa.stepup_note')) ? <p>{text(key('mfa.stepup_note'))}</p> : null}
        </section>
      ) : null}

      {sessions.ok && text(key('sessions.title')) ? (
        <section aria-labelledby="security-sessions">
          <h2 id="security-sessions">{text(key('sessions.title'))}</h2>
          {!sessions.value.reconciled && text(key('sessions.unreconciled')) ? <p role="status">{text(key('sessions.unreconciled'))}</p> : null}
          {activeSessions.length === 0 ? (
            text(key('sessions.empty')) ? (
              <p>{text(key('sessions.empty'))}</p>
            ) : null
          ) : (
            <ul>
              {activeSessions.map((s) => {
                const seen = lastSeenBy.get(when(s.lastSeenAt));
                return (
                  <li key={s.sessionId}>
                    {deviceLine(s.device) ? <span>{deviceLine(s.device)}</span> : null}
                    {s.current && currentLabel ? <strong> {currentLabel}</strong> : null}
                    {seen ? <span> {renderContent(seen)}</span> : null}
                    {!s.current && text(key('sessions.sign_out')) ? (
                      <form method="post" action="/auth/security/revoke-session">
                        <input type="hidden" name="sessionId" value={s.sessionId} />
                        <button type="submit">{text(key('sessions.sign_out'))}</button>
                      </form>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      {/* always offered, whatever the list shows: it also ends the sessions the API has not seen yet (it raises the revocation watermark) */}
      {text(key('sessions.sign_out_everywhere')) ? (
        <form method="post" action="/auth/security/revoke-all">
          <button type="submit">{text(key('sessions.sign_out_everywhere'))}</button>
        </form>
      ) : null}

      {devices.ok && text(key('devices.title')) ? (
        <section aria-labelledby="security-devices">
          <h2 id="security-devices">{text(key('devices.title'))}</h2>
          {deviceList.length === 0 ? (
            text(key('devices.none')) ? (
              <p>{text(key('devices.none'))}</p>
            ) : null
          ) : (
            <>
              {text(key('devices.trust_note')) ? <p>{text(key('devices.trust_note'))}</p> : null}
              <ul>
                {deviceList.map((d) => {
                  const until = d.trusted && d.trustedUntil ? trustedUntilBy.get(when(d.trustedUntil)) : undefined;
                  return (
                    <li key={d.deviceId}>
                      {deviceLine(d.device) ? <span>{deviceLine(d.device)}</span> : null}
                      {d.current && currentLabel ? <strong> {currentLabel}</strong> : null}
                      {until ? <span> {renderContent(until)}</span> : null}
                      {d.current && !d.trusted && text(key('devices.trust')) ? (
                        <form method="post" action="/auth/security/trust-device">
                          <button type="submit">{text(key('devices.trust'))}</button>
                        </form>
                      ) : null}
                      {d.current && d.trusted && text(key('devices.untrust')) ? (
                        <form method="post" action="/auth/security/untrust-device">
                          <button type="submit">{text(key('devices.untrust'))}</button>
                        </form>
                      ) : null}
                      {text(key('devices.remove')) ? (
                        <form method="post" action="/auth/security/remove-device">
                          <input type="hidden" name="deviceId" value={d.deviceId} />
                          <button type="submit">{text(key('devices.remove'))}</button>
                        </form>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      ) : null}

      {activity.ok && text(key('activity.title')) ? (
        <section aria-labelledby="security-activity">
          <h2 id="security-activity">{text(key('activity.title'))}</h2>
          {entries.length === 0 ? (
            text(key('activity.empty')) ? (
              <p>{text(key('activity.empty'))}</p>
            ) : null
          ) : (
            <ul>
              {entries.map((e) => (
                <li key={e.id}>
                  {text(securityActivityLabelKey(e.type)) ? <span>{text(securityActivityLabelKey(e.type))}</span> : null}{' '}
                  <time dateTime={e.occurredAt}>{when(e.occurredAt)}</time>
                  {deviceLine(e.device) ? <span> {deviceLine(e.device)}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {/* POST + same-origin check; there is deliberately no GET logout link (CSRF) */}
      <form method="post" action="/auth/logout">
        <button type="submit">{signOut}</button>
      </form>
    </>
  );
}
