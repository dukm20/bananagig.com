import { ACCOUNT_SECTIONS } from '@bananagig/contracts';
import { accountMetadata, C, CONSENTS_ALL_DONE_KEY, readSection, requireAccountArea, sectionOrNotFound } from '../../../lib/account-area';
import { getContent, renderContent } from '../../../lib/content';
import { serverApi } from '../../../lib/server';
import { Unavailable } from '../_components/feedback';
import { SectionFrame } from '../_components/section-frame';

export const dynamic = 'force-dynamic';
export const generateMetadata = () => accountMetadata(ACCOUNT_SECTIONS.privacyData);

// Privacy and data section: whether every required agreement is accepted (a count only; the agreements and their history are on /consents) and the data-download block, which says
// the download is not available until the API says it is (`dataDownload.available`; no export exists yet).
export default async function PrivacyPage() {
  const area = await requireAccountArea('/account/privacy');
  if (area.kind !== 'ready') return null;
  const section = sectionOrNotFound(area, ACCOUNT_SECTIONS.privacyData);
  const { copy } = area;
  const data = await readSection(() => serverApi(area.accessToken).getAccountPrivacySummary(area.call));
  // the one copy with a variable: {count} is the number of agreements that need attention
  const outstanding =
    data && !data.consents.satisfied ? renderContent(await getContent(C.privacyOutstanding, { variables: { count: data.consents.outstandingCount } })) : null;
  const consentsSummary = data ? (data.consents.satisfied ? copy.node(CONSENTS_ALL_DONE_KEY) : outstanding) : null;
  const open = copy.plain(C.privacyOpenConsents);
  return (
    <SectionFrame copy={copy} section={section}>
      {!data ? <Unavailable copy={copy} unavailableKey={C.unavailable} /> : null}
      {data ? (
        <>
          <section aria-labelledby="account-privacy-consents">
            {copy.node(C.privacyConsents) ? <h2 id="account-privacy-consents">{copy.node(C.privacyConsents)}</h2> : null}
            {consentsSummary ? <p>{consentsSummary}</p> : null}
            {open ? (
              <p>
                <a className="account-link" href="/consents">
                  {open}
                </a>
              </p>
            ) : null}
          </section>
          <section aria-labelledby="account-privacy-download">
            {copy.node(C.privacyDownload) ? <h2 id="account-privacy-download">{copy.node(C.privacyDownload)}</h2> : null}
            {/* no download control exists until a later checkpoint builds the export: while the API says it is not available, only the message is shown */}
            {!data.dataDownload.available && copy.node(C.privacyDownloadUnavailable) ? <p>{copy.node(C.privacyDownloadUnavailable)}</p> : null}
          </section>
        </>
      ) : null}
    </SectionFrame>
  );
}
