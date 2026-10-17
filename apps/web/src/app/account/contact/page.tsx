import { ACCOUNT_SECTIONS, emailStatusLabelKey, phoneStatusLabelKey, type EmailVerificationStatus } from '@bananagig/contracts';
import { accountMetadata, C, readSection, requireAccountArea, sectionOrNotFound, type Copy } from '../../../lib/account-area';
import { serverApi } from '../../../lib/server';
import { Unavailable } from '../_components/feedback';
import { SectionFrame } from '../_components/section-frame';

export const dynamic = 'force-dynamic';
export const generateMetadata = () => accountMetadata(ACCOUNT_SECTIONS.contactVerification);

interface ContactState {
  status: EmailVerificationStatus;
  /** The masked value of the verified (primary) contact, if any. */
  primary: string | undefined;
  /** The masked value of a contact waiting for verification, if any. */
  pending: string | undefined;
}

/** One contact (email or phone): its masked value and verification status, a waiting replacement with the registry's "waiting" note, or "not added yet". Only masked values ever arrive. */
function ContactRows({
  copy,
  label,
  state,
  statusKey,
}: {
  copy: Copy;
  label: string | undefined;
  state: ContactState;
  statusKey: (s: EmailVerificationStatus) => string;
}) {
  const status = copy.plain(statusKey(state.status));
  const shown = state.primary ?? state.pending;
  return (
    <>
      {label ? <dt>{label}</dt> : null}
      <dd>
        {shown === undefined ? (
          copy.node(C.contactNotAdded)
        ) : (
          <>
            <span>{shown}</span>
            {status ? <span className="account-badge">{status}</span> : null}
          </>
        )}
        {state.primary !== undefined && state.pending !== undefined ? (
          <span className="account-pending">
            {copy.node(C.contactPendingNote)} <span>{state.pending}</span>
          </span>
        ) : null}
      </dd>
    </>
  );
}

// Contact details section: the masked email and phone with their verification status labels, the summary, and the link to the existing email verification page. There is
// deliberately no phone action: no phone page exists yet.
export default async function ContactPage() {
  const area = await requireAccountArea('/account/contact');
  if (area.kind !== 'ready') return null;
  const section = sectionOrNotFound(area, ACCOUNT_SECTIONS.contactVerification);
  const { copy } = area;
  const data = await readSection(() => serverApi(area.accessToken).getAccountContactVerification(area.call));
  const summary = data ? copy.node(data.contacts.contactsVerified ? C.contactAllVerified : C.contactNotAllVerified) : null;
  const verify = copy.plain(C.contactVerifyEmail);
  const emailDone = data?.email.emailVerificationStatus === 'VERIFIED' && data.email.pending === null;
  return (
    <SectionFrame copy={copy} section={section}>
      {!data ? <Unavailable copy={copy} unavailableKey={C.unavailable} /> : null}
      {summary ? <p>{summary}</p> : null}
      {data ? (
        <dl>
          <ContactRows
            copy={copy}
            label={copy.plain(C.contactEmail)}
            state={{ status: data.email.emailVerificationStatus, primary: data.email.primary?.maskedEmail, pending: data.email.pending?.maskedEmail }}
            statusKey={emailStatusLabelKey}
          />
          <ContactRows
            copy={copy}
            label={copy.plain(C.contactPhone)}
            state={{ status: data.phone.phoneVerificationStatus, primary: data.phone.primary?.maskedPhone, pending: data.phone.pending?.maskedPhone }}
            statusKey={phoneStatusLabelKey}
          />
        </dl>
      ) : null}
      {data && !emailDone && verify ? (
        <p>
          <a className="account-link" href="/verify-email">
            {verify}
          </a>
        </p>
      ) : null}
    </SectionFrame>
  );
}
