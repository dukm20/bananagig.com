import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import {
  PROVIDER_ERROR_CODES,
  providerErrorKey,
  providerRegistrationStatusKey,
  providerRoleStateKey,
  type CatalogServiceTypeDto,
  type MarketDto,
  type ProviderErrorCode,
  type ProviderRegistrationStateDto,
  type ProviderRequirementsDto,
} from '@bananagig/contracts';
import { ApiError } from '../../../lib/api-client';
import { getSession, isSessionRevokedError } from '../../../lib/auth/handlers';
import { authDeps } from '../../../lib/auth/runtime';
import { BOOTSTRAP_COPY, getContentMany, renderContent } from '../../../lib/content';
import { serverApi } from '../../../lib/server';

// Provider registration (PRO-001): a deliberately MINIMAL, temporary flow so a signed-in person can become a provider with the account they already have: start (or resume),
// choose a market, choose service types, see the progress of every onboarding step, submit and cancel. It decides nothing: every status shown is what the API derived from
// the owners (contacts, consent, the configured policy), and Submit is only OFFERED when the API says the registration is ready (the server decides again). All user-visible
// text is registry copy (`provider.registration.*`); nothing is hardcoded here. The polished provider onboarding is a later checkpoint. No script, no pre-selected consent
// (consent is accepted on /consents), and nothing in the URL is echoed except through closed lists of words.
export const metadata: Metadata = { title: 'Become a provider', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

const page = (suffix: string): string => `provider.registration.page.${suffix}`;
const ERROR_KEYS: Readonly<Record<string, string>> = Object.fromEntries(
  PROVIDER_ERROR_CODES.map((c) => [`PROVIDER_${c}`, providerErrorKey(c as ProviderErrorCode)]),
);
/** What any other error word says: the generic "unavailable" message of the registry, never the word itself. */
const GENERIC_ERROR_KEY = providerErrorKey('UNAVAILABLE');
/** Notice words that carry copy (the other words are reflected by the page state itself and need none). */
const NOTICE_KEYS: Readonly<Record<string, string>> = { submitted: page('completed_notice'), cancelled: page('cancelled_notice') };
/** The next step after a completed registration: the provider's Gigs (CAT-003); the link text is the Gigs page title, omitted when the registry cannot serve it. */
const GIGS_LINK_KEY = 'provider.gig.page.title';
/** The most markets and service types the page lists (the lists are bounded by the platform; this bounds one render). */
const MAX_OPTIONS = 200;

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

interface SearchParams {
  notice?: string | string[];
  error?: string | string[];
}

export default async function ProviderRegistrationPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const session = await getSession((await headers()).get('cookie'), authDeps());
  if (!session) {
    const copy = await getContentMany([page('title'), 'common.action.sign_in']);
    const title = renderContent(copy[page('title')]);
    return (
      <>
        {title ? <h1>{title}</h1> : null}
        <p>
          <a href="/auth/login?returnTo=/provider/registration">{renderContent(copy['common.action.sign_in']) ?? BOOTSTRAP_COPY.signIn}</a>
        </p>
      </>
    );
  }

  const api = serverApi(session.record.accessToken);
  const o = { activeRole: session.record.activeRole };
  const [state, requirements] = await Promise.all([
    load<ProviderRegistrationStateDto>(() => api.getProviderRegistration(o)),
    load<ProviderRequirementsDto>(() => api.getProviderRequirements({}, o)),
  ]);

  const registration = state.ok ? state.value.registration : null;
  const live = registration !== null && registration.status === 'IN_PROGRESS' ? registration : null;
  const completed = registration !== null && registration.status === 'COMPLETED';
  const canRestart = registration !== null && registration.status === 'CANCELLED';

  // the options are the PUBLIC lists (no token): the ACTIVE markets in effect and the service types offered in the chosen market
  const markets: MarketDto[] = live ? await load<MarketDto[]>(() => api.listGeographyMarkets()).then((r) => (r.ok ? r.value.slice(0, MAX_OPTIONS) : [])) : [];
  const serviceTypes: CatalogServiceTypeDto[] =
    live && live.marketCode
      ? await load<CatalogServiceTypeDto[]>(() => api.listMarketServiceTypes(live.marketCode!)).then((r) => (r.ok ? r.value.slice(0, MAX_OPTIONS) : []))
      : [];

  const steps = requirements.ok ? requirements.value.steps : [];
  const ready = requirements.ok && requirements.value.overall.registrationReady;
  const noticeWord = one(query.notice);
  // a notice is only shown when the data proves what it claims (the words in the URL can be typed by anyone)
  const noticeKey =
    noticeWord !== undefined &&
    Object.hasOwn(NOTICE_KEYS, noticeWord) &&
    ((noticeWord === 'submitted' && completed) || (noticeWord === 'cancelled' && canRestart))
      ? NOTICE_KEYS[noticeWord]
      : undefined;
  const errorWord = one(query.error);
  const errorKey = errorWord !== undefined ? (Object.hasOwn(ERROR_KEYS, errorWord) ? ERROR_KEYS[errorWord] : GENERIC_ERROR_KEY) : undefined;
  const everythingDown = !state.ok;

  const copy = await getContentMany([
    page('title'),
    page('intro'),
    ...(noticeKey ? [noticeKey] : []),
    ...(errorKey ? [errorKey] : everythingDown ? [GENERIC_ERROR_KEY] : []),
    ...(state.ok ? [providerRoleStateKey(state.value.providerRole)] : []),
    ...(registration ? [providerRegistrationStatusKey(registration.status)] : []),
    ...(state.ok && (registration === null || canRestart) ? [canRestart ? page('restart_action') : page('start_action')] : []),
    ...steps.flatMap((s) => [s.labelKey, s.statusKey]),
    ...(steps.length > 0 ? [page('progress_heading')] : []),
    ...(live
      ? [
          page('market_heading'),
          page('market_label'),
          page('market_help'),
          page('services_heading'),
          page('services_help'),
          page('save_action'),
          page('cancel_action'),
          ...(markets.length === 0 ? [page('empty_markets')] : []),
          ...(live.marketCode && serviceTypes.length === 0 ? [page('empty_services')] : []),
          ...(ready ? [page('submit_action')] : []),
          ...(steps.some((s) => s.step === 'CONTACT' && s.status !== 'COMPLETE' && s.status !== 'NOT_REQUIRED') ? [page('contact_hint')] : []),
          ...(steps.some((s) => s.step === 'LEGAL' && s.status !== 'COMPLETE' && s.status !== 'NOT_REQUIRED') ? [page('legal_hint')] : []),
        ]
      : []),
    ...(completed ? [page('golive_note'), GIGS_LINK_KEY] : []),
  ]);
  const text = (k: string) => renderContent(copy[k]);

  const failure = errorKey ? text(errorKey) : everythingDown ? text(GENERIC_ERROR_KEY) : null;
  const notice = noticeKey ? text(noticeKey) : null;
  const title = text(page('title'));
  const intro = text(page('intro'));
  const errorId = 'provider-error';
  const describedBy = failure ? { 'aria-describedby': errorId } : {};
  const selected = new Set(live?.serviceTypeCodes ?? []);

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
      {state.ok && text(providerRoleStateKey(state.value.providerRole)) ? <p>{text(providerRoleStateKey(state.value.providerRole))}</p> : null}
      {registration && text(providerRegistrationStatusKey(registration.status)) ? <p>{text(providerRegistrationStatusKey(registration.status))}</p> : null}

      {state.ok && (registration === null || canRestart) && text(canRestart ? page('restart_action') : page('start_action')) ? (
        <form method="post" action="/auth/provider/start" {...describedBy}>
          <button type="submit">{text(canRestart ? page('restart_action') : page('start_action'))}</button>
        </form>
      ) : null}

      {steps.length > 0 && text(page('progress_heading')) ? (
        <section aria-labelledby="provider-progress">
          <h2 id="provider-progress">{text(page('progress_heading'))}</h2>
          <ul>
            {steps.map((s) => (
              <li key={s.step}>
                {text(s.labelKey) ? <span>{text(s.labelKey)}</span> : null} {text(s.statusKey) ? <span>{text(s.statusKey)}</span> : null}
              </li>
            ))}
          </ul>
          {text(page('contact_hint')) ? <p>{text(page('contact_hint'))}</p> : null}
          {text(page('legal_hint')) ? (
            <p>
              <a href="/consents">{text(page('legal_hint'))}</a>
            </p>
          ) : null}
        </section>
      ) : null}

      {live ? (
        <>
          <section aria-labelledby="provider-market">
            {text(page('market_heading')) ? <h2 id="provider-market">{text(page('market_heading'))}</h2> : null}
            {markets.length === 0 ? (
              text(page('empty_markets')) ? (
                <p>{text(page('empty_markets'))}</p>
              ) : null
            ) : (
              <form method="post" action="/auth/provider/market" {...describedBy}>
                <input type="hidden" name="expectedRevision" value={live.revision} />
                <fieldset aria-describedby="provider-market-help">
                  {text(page('market_label')) ? <legend>{text(page('market_label'))}</legend> : null}
                  {text(page('market_help')) ? <p id="provider-market-help">{text(page('market_help'))}</p> : null}
                  {markets.map((m) => (
                    <div key={m.code} className="provider-choice">
                      <input
                        type="radio"
                        id={`provider-market-${m.code}`}
                        name="marketCode"
                        value={m.code}
                        defaultChecked={m.code === live.marketCode}
                        required
                      />
                      <label htmlFor={`provider-market-${m.code}`}>{m.name}</label>
                    </div>
                  ))}
                </fieldset>
                {text(page('save_action')) ? <button type="submit">{text(page('save_action'))}</button> : null}
              </form>
            )}
          </section>

          {live.marketCode ? (
            <section aria-labelledby="provider-services">
              {text(page('services_heading')) ? <h2 id="provider-services">{text(page('services_heading'))}</h2> : null}
              {serviceTypes.length === 0 ? (
                text(page('empty_services')) ? (
                  <p>{text(page('empty_services'))}</p>
                ) : null
              ) : (
                <form method="post" action="/auth/provider/services" {...describedBy}>
                  <input type="hidden" name="expectedRevision" value={live.revision} />
                  <fieldset aria-describedby="provider-services-help">
                    {text(page('services_heading')) ? <legend>{text(page('services_heading'))}</legend> : null}
                    {text(page('services_help')) ? <p id="provider-services-help">{text(page('services_help'))}</p> : null}
                    {serviceTypes.map((t) => (
                      <div key={t.code} className="provider-choice">
                        <input type="checkbox" id={`provider-service-${t.code}`} name="serviceTypeCode" value={t.code} defaultChecked={selected.has(t.code)} />
                        <label htmlFor={`provider-service-${t.code}`}>{t.name}</label>
                      </div>
                    ))}
                  </fieldset>
                  {text(page('save_action')) ? <button type="submit">{text(page('save_action'))}</button> : null}
                </form>
              )}
            </section>
          ) : null}

          {ready && text(page('submit_action')) ? (
            <form method="post" action="/auth/provider/submit" {...describedBy}>
              <input type="hidden" name="expectedRevision" value={live.revision} />
              <button type="submit">{text(page('submit_action'))}</button>
            </form>
          ) : null}
          {text(page('cancel_action')) ? (
            <form method="post" action="/auth/provider/cancel" {...describedBy}>
              <button type="submit">{text(page('cancel_action'))}</button>
            </form>
          ) : null}
        </>
      ) : null}

      {completed && text(page('golive_note')) ? <p>{text(page('golive_note'))}</p> : null}
      {completed && text(GIGS_LINK_KEY) ? (
        <p>
          <a href="/provider/gigs">{text(GIGS_LINK_KEY)}</a>
        </p>
      ) : null}
    </div>
  );
}
