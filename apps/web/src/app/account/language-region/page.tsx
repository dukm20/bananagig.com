import { ACCOUNT_SECTIONS, type LocaleDto, type TimeZoneDto } from '@bananagig/contracts';
import { ApiError } from '../../../lib/api-client';
import { accountMetadata, C, feedbackKeys, readSection, requireAccountArea, sectionOrNotFound } from '../../../lib/account-area';
import { serverApi } from '../../../lib/server';
import { Feedback, Unavailable } from '../_components/feedback';
import { SectionFrame } from '../_components/section-frame';

export const dynamic = 'force-dynamic';
export const generateMetadata = () => accountMetadata(ACCOUNT_SECTIONS.languageRegion);

/** `?error=` words the language form returns (the BFF handler's closed list) -> the content key of their message. */
const ERROR_KEYS: Readonly<Record<string, string>> = { save: C.errorSaveFailed, choice: C.errorInvalidChoice };

/** A public list (ACTIVE locales / time zones: no token is sent, so the API returns active data only); undefined when it cannot be read. */
async function publicList<T>(read: () => Promise<T[]>): Promise<T[] | undefined> {
  try {
    return await read();
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return undefined;
  }
}

// Language and region section: a select of the ACTIVE content locales and one of the ACTIVE time zones, each with the "use the default for my area" choice (an empty value, which
// the form handler turns into null). The server validates the choice; a rejected one comes back as ?error=choice. Without a profile there is nothing to change yet (the
// API needs both names first), so the page points to the Profile section instead of offering a form that could only fail.
export default async function LanguageRegionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const area = await requireAccountArea('/account/language-region');
  if (area.kind !== 'ready') return null;
  const section = sectionOrNotFound(area, ACCOUNT_SECTIONS.languageRegion);
  const { copy } = area;
  const publicApi = serverApi();
  const [data, locales, zones] = await Promise.all([
    readSection(() => serverApi(area.accessToken).getAccountProfile(area.call)),
    publicList<LocaleDto>(() => publicApi.listContentLocales()),
    publicList<TimeZoneDto>(() => publicApi.listGeographyTimeZones()),
  ]);
  const feedback = feedbackKeys(query, ERROR_KEYS);
  const profile = data?.profile ?? null;
  const loaded = data !== undefined && locales !== undefined && zones !== undefined;
  const activeLocales = (locales ?? []).filter((l) => l.isActive);
  const activeZones = (zones ?? []).filter((z) => z.status === undefined || z.status === 'ACTIVE');
  // A stored value that is no longer ACTIVE is still the person's value: it is offered (selected, labelled with the tag itself, marked data-inactive) right after the default
  // option, so saving the other field submits it back unchanged instead of silently clearing it. Choosing another option or the default option still works.
  const storedLocale = profile?.preferredLocale ?? null;
  const storedZone = profile?.timeZone ?? null;
  const staleLocale = storedLocale !== null && !activeLocales.some((l) => l.locale === storedLocale) ? storedLocale : null;
  const staleZone = storedZone !== null && !activeZones.some((z) => z.ianaName === storedZone) ? storedZone : null;
  const localeLabel = copy.plain(C.languageLocale);
  const zoneLabel = copy.plain(C.languageTimeZone);
  const defaultOption = copy.plain(C.defaultOption);
  const save = copy.plain(C.actionSave);
  const profileSection = area.nav.sections.find((s) => s.code === ACCOUNT_SECTIONS.profile);
  const profileLink = copy.plain(profileSection?.labelContentKey);
  return (
    <SectionFrame copy={copy} section={section}>
      <Feedback copy={copy} notice={feedback.notice} error={feedback.error} />
      {!loaded ? <Unavailable copy={copy} unavailableKey={C.unavailable} /> : null}
      {loaded && !profile ? (
        <>
          {copy.node(C.profileEmpty) ? <p>{copy.node(C.profileEmpty)}</p> : null}
          {profileSection && profileLink ? (
            <p>
              <a className="account-link" href={profileSection.route}>
                {profileLink}
              </a>
            </p>
          ) : null}
        </>
      ) : null}
      {loaded && profile && localeLabel && zoneLabel && defaultOption && save ? (
        <form className="account-form" method="post" action="/auth/account/language-region">
          <div className="account-field">
            <label htmlFor="account-locale">{localeLabel}</label>
            <select id="account-locale" name="preferredLocale" defaultValue={profile.preferredLocale ?? ''}>
              <option value="">{defaultOption}</option>
              {staleLocale !== null ? (
                <option value={staleLocale} data-inactive="">
                  {staleLocale}
                </option>
              ) : null}
              {activeLocales.map((l) => (
                <option key={l.locale} value={l.locale}>
                  {l.displayName}
                </option>
              ))}
            </select>
          </div>
          <div className="account-field">
            <label htmlFor="account-time-zone">{zoneLabel}</label>
            <select id="account-time-zone" name="timeZone" defaultValue={profile.timeZone ?? ''}>
              <option value="">{defaultOption}</option>
              {staleZone !== null ? (
                <option value={staleZone} data-inactive="">
                  {staleZone}
                </option>
              ) : null}
              {activeZones.map((z) => (
                <option key={z.ianaName} value={z.ianaName}>
                  {z.ianaName}
                </option>
              ))}
            </select>
          </div>
          <button type="submit">{save}</button>
        </form>
      ) : null}
    </SectionFrame>
  );
}
