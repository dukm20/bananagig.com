import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { randomUUID } from 'node:crypto';
import type { ReactNode } from 'react';
import { gigStatusKey, type GigChildSummaryDto, type GigMenuDto, type GigTemplateChoicesDto } from '@bananagig/contracts';
import { getSession } from '../../../lib/auth/handlers';
import { authDeps } from '../../../lib/auth/runtime';
import { BOOTSTRAP_COPY, getContentMany, renderContent } from '../../../lib/content';
import { GENERIC_GIG_ERROR_KEY, GIG_ERROR_KEYS, gigCopy, gigKey, loadGig, one } from '../../../lib/provider-gigs';
import { serverApi } from '../../../lib/server';

// The provider GigMenu (CAT-003): a deliberately MINIMAL, server-rendered page where a signed-in provider sees every Gig of the account (current version, draft, status), the
// limits, whether a new Gig can be started now and from which Gig Templates, and opens one in the editor. It decides nothing: the list, the limits, `canCreate` and the template
// choices are what the API computed for THIS account (market, selected service types and the configured caps), and the create form is only OFFERED when the API says it can
// work (the server decides again). A Gig is not live and not bookable; the page says so. All user-visible platform text is registry copy (`provider.gig.*`); what the
// provider wrote (titles, pitches) is rendered as plain text nodes only. No script; nothing in the URL is echoed except through a closed list of error words.
export const metadata: Metadata = { title: 'Your Gigs', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

const k = gigKey;
/** The next step after the Gigs: the public profile (PRO-002); the link text is its page title, omitted when the registry cannot serve it. */
const PROFILE_LINK_KEY = 'provider.profile.page.title';

interface SearchParams {
  notice?: string | string[];
  error?: string | string[];
}

/** The counts of variants, add-ons and photos of a version, and a text note when the photo requirement is not met (facts from the API; nothing here decides). */
function ChildCounts({ summary: c, text, id, labelledBy }: { summary: GigChildSummaryDto; text: (key: string) => ReactNode; id: string; labelledBy: string }) {
  const rows: Array<[string, number]> = [
    ['menu.variants', c.variantCount],
    ['menu.add_ons', c.addOnCount],
    ['menu.photos', c.mediaCount],
  ];
  const shown = rows.filter(([key]) => text(k(key)));
  return (
    <>
      {shown.length > 0 ? (
        <dl className="gig-facts gig-counts" id={id} aria-labelledby={labelledBy}>
          {shown.map(([key, n]) => (
            <div className="gig-row" key={key}>
              <dt>{text(k(key))}</dt>
              <dd>{n}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {!c.mediaRequirementSatisfied && text(k('menu.photos_missing')) ? <p className="gig-note">{text(k('menu.photos_missing'))}</p> : null}
    </>
  );
}

export default async function ProviderGigsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const session = await getSession((await headers()).get('cookie'), authDeps());
  if (!session) {
    const copy = await getContentMany([k('page.title'), 'common.action.sign_in']);
    const title = renderContent(copy[k('page.title')]);
    return (
      <>
        {title ? <h1>{title}</h1> : null}
        <p>
          <a href="/auth/login?returnTo=/provider/gigs">{renderContent(copy['common.action.sign_in']) ?? BOOTSTRAP_COPY.signIn}</a>
        </p>
      </>
    );
  }

  const api = serverApi(session.record.accessToken);
  const o = { activeRole: session.record.activeRole };
  const menu = await loadGig<GigMenuDto>(() => api.getGigMenu(o));
  const m = menu.ok ? menu.value : null;
  // the template choices are only read when the API says a Gig can be created now
  const choices = m && m.canCreate ? await loadGig<GigTemplateChoicesDto>(() => api.listGigTemplateChoices(o)) : null;
  const templates = choices?.ok ? choices.value.templates : [];

  const errorWord = one(query.error);
  const errorKey = errorWord !== undefined ? (Object.hasOwn(GIG_ERROR_KEYS, errorWord) ? GIG_ERROR_KEYS[errorWord] : GENERIC_GIG_ERROR_KEY) : undefined;
  const everythingDown = !menu.ok;

  const text = await gigCopy([
    k('page.title'),
    k('page.intro'),
    k('menu.heading'),
    k('menu.not_live_note'),
    ...(errorKey ? [errorKey] : everythingDown ? [GENERIC_GIG_ERROR_KEY] : []),
    ...(m
      ? [
          k('menu.limits_heading'),
          k('menu.limit_active'),
          k('menu.limit_drafts'),
          k('menu.open'),
          k('menu.current_version'),
          k('menu.draft_version'),
          k('menu.no_published'),
          k('menu.price'),
          k('menu.duration'),
          k('menu.variants'),
          k('menu.add_ons'),
          k('menu.photos'),
          k('menu.photos_missing'),
          k('editor.version'),
          PROFILE_LINK_KEY,
          ...(m.gigs.length === 0 ? [k('menu.empty')] : []),
          ...(m.cannotCreateReason === 'PROVIDER_NOT_ELIGIBLE' ? [k('menu.not_eligible')] : []),
          ...(m.cannotCreateReason === 'DRAFT_LIMIT_REACHED' ? [k('menu.draft_limit')] : []),
          ...(m.canCreate
            ? [
                k('create.heading'),
                k('create.template'),
                k('create.submit'),
                k('editor.select_empty'),
                ...(templates.length === 0 ? [k('create.none_available')] : []),
              ]
            : []),
          ...m.gigs.flatMap((g) => [g.gig.nameContentKey, gigStatusKey(g.gig.status)]),
          ...templates.map((t) => t.nameContentKey),
        ]
      : []),
  ]);

  const failure = errorKey ? text(errorKey) : everythingDown ? text(GENERIC_GIG_ERROR_KEY) : null;
  const title = text(k('page.title'));
  const intro = text(k('page.intro'));
  const errorId = 'gig-error';
  const describedBy = failure ? { 'aria-describedby': errorId } : {};

  return (
    <div className="provider-registration provider-gigs">
      {title ? <h1>{title}</h1> : null}
      {failure ? (
        <p id={errorId} role="alert">
          {failure}
        </p>
      ) : null}
      {intro ? <p>{intro}</p> : null}
      {text(k('menu.not_live_note')) ? <p className="gig-note">{text(k('menu.not_live_note'))}</p> : null}

      {m ? (
        <>
          {text(k('menu.limits_heading')) ? (
            <section aria-labelledby="gig-limits">
              <h2 id="gig-limits">{text(k('menu.limits_heading'))}</h2>
              <dl className="gig-facts">
                {text(k('menu.limit_active')) ? (
                  <div className="gig-row">
                    <dt>{text(k('menu.limit_active'))}</dt>
                    <dd>
                      {m.limits.activeCount} / {m.limits.maxActive}
                    </dd>
                  </div>
                ) : null}
                {text(k('menu.limit_drafts')) ? (
                  <div className="gig-row">
                    <dt>{text(k('menu.limit_drafts'))}</dt>
                    <dd>
                      {m.limits.draftCount} / {m.limits.maxDrafts}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </section>
          ) : null}

          <section aria-labelledby="gig-list">
            {text(k('menu.heading')) ? <h2 id="gig-list">{text(k('menu.heading'))}</h2> : null}
            {m.gigs.length === 0 ? (
              text(k('menu.empty')) ? (
                <p>{text(k('menu.empty'))}</p>
              ) : null
            ) : (
              <ul className="gig-list">
                {m.gigs.map((g) => {
                  const name = text(g.gig.nameContentKey);
                  const cv = g.currentVersion;
                  const dv = g.draftVersion;
                  return (
                    <li key={g.gig.gigId}>
                      <h3 id={`gig-name-${g.gig.gigId}`}>{name ?? g.gig.gigTemplateCode}</h3>
                      {text(gigStatusKey(g.gig.status)) ? <p className="gig-status">{text(gigStatusKey(g.gig.status))}</p> : null}
                      {cv ? (
                        <dl className="gig-facts">
                          <div className="gig-row">
                            <dt id={`gig-current-label-${g.gig.gigId}`}>
                              {text(k('menu.current_version'))}{' '}
                              {text(k('editor.version')) ? (
                                <span>
                                  ({text(k('editor.version'))} {cv.versionNumber})
                                </span>
                              ) : null}
                            </dt>
                            <dd>{cv.title}</dd>
                          </div>
                          {cv.price && text(k('menu.price')) ? (
                            <div className="gig-row">
                              <dt>{text(k('menu.price'))}</dt>
                              <dd>
                                {cv.price.amountMinor} {cv.price.currency}
                              </dd>
                            </div>
                          ) : null}
                          {cv.durationMinutes !== null && text(k('menu.duration')) ? (
                            <div className="gig-row">
                              <dt>{text(k('menu.duration'))}</dt>
                              <dd>{cv.durationMinutes}</dd>
                            </div>
                          ) : null}
                        </dl>
                      ) : text(k('menu.no_published')) ? (
                        <p>{text(k('menu.no_published'))}</p>
                      ) : null}
                      {cv ? (
                        <ChildCounts
                          id={`gig-counts-${g.gig.gigId}-current`}
                          labelledBy={`gig-current-label-${g.gig.gigId} gig-name-${g.gig.gigId}`}
                          text={text}
                          summary={cv.children}
                        />
                      ) : null}
                      {dv && text(k('menu.draft_version')) ? (
                        <p id={`gig-draft-label-${g.gig.gigId}`}>
                          {text(k('menu.draft_version'))}
                          {text(k('editor.version')) ? (
                            <>
                              {' '}
                              ({text(k('editor.version'))} {dv.versionNumber})
                            </>
                          ) : null}
                          {dv.title ? <>: {dv.title}</> : null}
                        </p>
                      ) : null}
                      {dv ? (
                        <ChildCounts
                          id={`gig-counts-${g.gig.gigId}-draft`}
                          labelledBy={`${text(k('menu.draft_version')) ? `gig-draft-label-${g.gig.gigId} ` : ''}gig-name-${g.gig.gigId}`}
                          text={text}
                          summary={dv.children}
                        />
                      ) : null}
                      {text(k('menu.open')) ? (
                        <p>
                          <a
                            id={`gig-open-${g.gig.gigId}`}
                            href={`/provider/gigs/${g.gig.gigId}`}
                            aria-labelledby={`gig-open-${g.gig.gigId} gig-name-${g.gig.gigId}`}
                          >
                            {text(k('menu.open'))}
                          </a>
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {m.canCreate ? (
            <section aria-labelledby="gig-create">
              {text(k('create.heading')) ? <h2 id="gig-create">{text(k('create.heading'))}</h2> : null}
              {templates.length === 0 ? (
                text(k('create.none_available')) ? (
                  <p>{text(k('create.none_available'))}</p>
                ) : null
              ) : text(k('create.template')) && text(k('create.submit')) ? (
                <form method="post" action="/auth/provider/gigs/create" {...describedBy}>
                  <input type="hidden" name="clientRequestId" value={randomUUID()} />
                  <div className="gig-field">
                    <label htmlFor="gig-template">{text(k('create.template'))}</label>
                    <select id="gig-template" name="gigTemplateCode" required>
                      <option value="">{text(k('editor.select_empty'))}</option>
                      {templates.map((t) => (
                        <option key={t.gigTemplateCode} value={t.gigTemplateCode}>
                          {text(t.nameContentKey) ?? t.gigTemplateCode}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button type="submit">{text(k('create.submit'))}</button>
                </form>
              ) : null}
            </section>
          ) : m.cannotCreateReason === 'PROVIDER_NOT_ELIGIBLE' && text(k('menu.not_eligible')) ? (
            <p>
              <a href="/provider/registration">{text(k('menu.not_eligible'))}</a>
            </p>
          ) : m.cannotCreateReason === 'DRAFT_LIMIT_REACHED' && text(k('menu.draft_limit')) ? (
            <p>{text(k('menu.draft_limit'))}</p>
          ) : null}
          {text(PROFILE_LINK_KEY) ? (
            <p>
              <a href="/provider/profile">{text(PROFILE_LINK_KEY)}</a>
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
