import type { ElementType, ReactNode } from 'react';
import { profileBadgeKey, type PreviewProviderProfileDto, type PublicProviderProfileDto } from '@bananagig/contracts';
import { formatMinutes, formatPrice, type ProfileText } from '../../../lib/provider-profile';

// The customer's view of a provider (PRO-002): ONE component for the public page and the owner's preview, so the preview can never show something the public page does not. It
// renders the public projection exactly as the API derived it: the name, the photo (through a controlled same-origin route), the trust badges as TEXT, the bio, and one card per
// published Gig. Ratings and BananaDrops are placeholders of the contract (`available: false`) and are NOT rendered: no number, no star, no empty box. Provider-written text (name, bio,
// Gig titles and pitches) is rendered as React text nodes only (and the name as an attribute value), never as markup. All platform wording is registry copy; absent copy is omitted.
// Nothing is computed here beyond the display format of one given price and one given duration.

/** The page-copy paths the view needs. */
export const PROFILE_VIEW_PATHS = [
  'public.badges_heading',
  'public.about_heading',
  'public.gigs_heading',
  'public.no_gigs',
  'public.price_from',
  'public.duration',
  'public.options',
  'public.not_bookable_note',
] as const;
/** The full registry keys the view needs for this profile: the badge labels and the service type names of the Gig cards. */
export const profileViewKeys = (profile: PublicProviderProfileDto): string[] => [
  ...profile.badges.map((b) => profileBadgeKey(b.type)),
  ...profile.gigs.map((g) => g.serviceTypeNameContentKey),
];

interface Props {
  profile: PublicProviderProfileDto | PreviewProviderProfileDto;
  text: ProfileText;
  /** The same-origin route the photo comes from (the public API route for the public page, the controlled owner route for the preview). */
  photoSrc: string;
  /** The heading level of the provider's name (1 on the public page, 2 on the preview); the sections are one level below, the Gig titles two. */
  level: 1 | 2;
  /**
   * Say, under the name, that the prices shown are not bookable (the public page). The owner's preview carries its own notes instead. The note appears whenever a price is shown
   * (and its copy exists): a price on the public page is never presented as something a customer can book.
   */
  notBookableNote?: boolean;
}

export function ProfileView({ profile, text, photoSrc, level, notBookableNote = false }: Props) {
  const Name = `h${level}` as ElementType;
  const Section = `h${level + 1}` as ElementType;
  const Card = `h${level + 2}` as ElementType;
  const { t, k } = text;
  const badges = profile.badges.map((b) => ({ type: b.type, label: k(profileBadgeKey(b.type)) })).filter((b) => b.label);
  const gigsHeading = t('public.gigs_heading');
  const showsPrice = profile.gigs.some((g) => g.price !== null) && Boolean(t('public.price_from'));

  return (
    <article className="provider-profile-view" aria-labelledby="profile-view-name">
      <header>
        {profile.photo ? (
          // a plain img on purpose: the bytes come through a controlled same-origin route that serves sanitised bytes (next/image would proxy and cache them)
          <img
            src={photoSrc}
            alt={profile.displayName}
            width={profile.photo.width}
            height={profile.photo.height}
            className="profile-photo"
            referrerPolicy="no-referrer"
          />
        ) : null}
        <Name id="profile-view-name">{profile.displayName}</Name>
        {notBookableNote && showsPrice && t('public.not_bookable_note') ? <p className="gig-note">{t('public.not_bookable_note')}</p> : null}
      </header>

      {badges.length > 0 ? (
        <section aria-labelledby={t('public.badges_heading') ? 'profile-view-badges' : undefined}>
          {t('public.badges_heading') ? <Section id="profile-view-badges">{t('public.badges_heading')}</Section> : null}
          <ul className="profile-badges">
            {badges.map((b) => (
              <li key={b.type}>{b.label}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {profile.bio !== null ? (
        <section aria-labelledby={t('public.about_heading') ? 'profile-view-about' : undefined}>
          {t('public.about_heading') ? <Section id="profile-view-about">{t('public.about_heading')}</Section> : null}
          <p className="gig-text">{profile.bio}</p>
        </section>
      ) : null}

      <section aria-labelledby={gigsHeading ? 'profile-view-gigs' : undefined}>
        {gigsHeading ? <Section id="profile-view-gigs">{gigsHeading}</Section> : null}
        {profile.gigs.length === 0 ? (
          t('public.no_gigs') ? (
            <p>{t('public.no_gigs')}</p>
          ) : null
        ) : (
          <ul className="gig-list">
            {profile.gigs.map((g, i) => {
              const service = k(g.serviceTypeNameContentKey);
              const options = g.variantCount + g.addOnCount;
              const rows: Array<{ id: string; label: ReactNode; value: ReactNode }> = [];
              if (g.price && t('public.price_from')) rows.push({ id: 'price', label: t('public.price_from'), value: formatPrice(g.price) });
              if (g.durationMinutes !== null && t('public.duration'))
                rows.push({ id: 'duration', label: t('public.duration'), value: formatMinutes(g.durationMinutes) });
              if (options > 0 && t('public.options')) rows.push({ id: 'options', label: t('public.options'), value: options });
              return (
                <li key={g.gigId}>
                  <Card id={`profile-view-gig-${i}`}>{g.title}</Card>
                  {service ? <p className="gig-status">{service}</p> : null}
                  {g.shortPitch ? <p className="gig-text">{g.shortPitch}</p> : null}
                  {rows.length > 0 ? (
                    <dl className="gig-facts" aria-labelledby={`profile-view-gig-${i}`}>
                      {rows.map((r) => (
                        <div className="gig-row" key={r.id}>
                          <dt>{r.label}</dt>
                          <dd>{r.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </article>
  );
}
