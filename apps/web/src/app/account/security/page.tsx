import { ACCOUNT_SECTIONS } from '@bananagig/contracts';
import { accountMetadata, C, readSection, requireAccountArea, sectionOrNotFound } from '../../../lib/account-area';
import { serverApi } from '../../../lib/server';
import { Unavailable } from '../_components/feedback';
import { SectionFrame } from '../_components/section-frame';

export const dynamic = 'force-dynamic';
export const generateMetadata = () => accountMetadata(ACCOUNT_SECTIONS.security);

// Security section: a read-only summary (two-step verification, live sessions, this browser) and the link to the security centre (/security), which stays the one place to act.
// No session or two-step logic lives here.
export default async function AccountSecurityPage() {
  const area = await requireAccountArea('/account/security');
  if (area.kind !== 'ready') return null;
  const section = sectionOrNotFound(area, ACCOUNT_SECTIONS.security);
  const { copy } = area;
  const data = await readSection(() => serverApi(area.accessToken).getAccountSecuritySummary(area.call));
  // the identity provider could not be asked: "unknown" (a different statement from "off")
  const mfaKey = !data ? undefined : !data.mfa.available ? C.securityMfaUnknown : data.mfa.enabled ? C.securityMfaOn : C.securityMfaOff;
  const open = copy.plain(C.securityOpen);
  return (
    <SectionFrame copy={copy} section={section}>
      {!data ? <Unavailable copy={copy} unavailableKey={C.unavailable} /> : null}
      {data ? (
        <dl>
          {copy.plain(C.securityMfa) && copy.node(mfaKey) ? (
            <>
              <dt>{copy.plain(C.securityMfa)}</dt>
              <dd>{copy.node(mfaKey)}</dd>
            </>
          ) : null}
          {copy.plain(C.securitySessions) ? (
            <>
              <dt>{copy.plain(C.securitySessions)}</dt>
              <dd>{data.activeSessionCount}</dd>
            </>
          ) : null}
          {copy.plain(C.securityBrowser) && copy.node(data.currentBrowserTrusted ? C.securityBrowserTrusted : C.securityBrowserNotTrusted) ? (
            <>
              <dt>{copy.plain(C.securityBrowser)}</dt>
              <dd>{copy.node(data.currentBrowserTrusted ? C.securityBrowserTrusted : C.securityBrowserNotTrusted)}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {open ? (
        <p>
          <a className="account-link" href="/security">
            {open}
          </a>
        </p>
      ) : null}
    </SectionFrame>
  );
}
