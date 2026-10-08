// Composition helpers for the email verification (ID-002): the three ports of EmailVerificationService/SmtpEmailSender that need other packages, wired in the
// API composition root. They live here (not in the packages) so `accounts` and `platform` never import `configuration` or `content`.
import { EMAIL_POLICY_PARAMETER_KEYS, parseEmailVerificationPolicy, type VerificationPolicyProvider } from '@bananagig/accounts';
import type { ConfigurationService } from '@bananagig/configuration';
import { renderResolved, type ContentService } from '@bananagig/content';
import { htmlToPlainText, type EmailRenderer } from '@bananagig/platform';

/** The email verification limits come from the configuration registry (CFG-001): CRITICAL parameters, read fresh, never defaulted in code. */
export function createVerificationPolicyProvider(configuration: Pick<ConfigurationService, 'resolveMany'>): VerificationPolicyProvider {
  return {
    async policy() {
      const { values } = await configuration.resolveMany([...EMAIL_POLICY_PARAMETER_KEYS]);
      return parseEmailVerificationPolicy(Object.fromEntries([...values].map(([key, resolved]) => [key, resolved.value])));
    },
  };
}

/**
 * Renders `<templateKey>.subject` and `<templateKey>.body` from the managed content registry (CFG-002); no user-visible copy is written in code. The registry
 * is strict (a value for a variable an entry does not define is an error), and the subject deliberately defines none (the code is never in the subject), so
 * each entry receives only the variables IT defines.
 */
export function createContentEmailRenderer(content: Pick<ContentService, 'resolveMany' | 'listLocales'>): EmailRenderer {
  return {
    async render(templateKey, variables, locale) {
      const requested = locale ?? (await content.listLocales({ activeOnly: true })).find((l) => l.isPlatformDefault)?.locale ?? 'en-US';
      const subjectKey = `${templateKey}.subject`;
      const bodyKey = `${templateKey}.body`;
      const { items } = await content.resolveMany([subjectKey, bodyKey], { locale: requested });
      const rendered = [subjectKey, bodyKey].map((key) => {
        const resolved = items.get(key);
        if (!resolved) throw new Error('an email template entry has no effective content');
        const defined = new Set(resolved.variables.map((v) => v.name));
        return renderResolved(resolved, Object.fromEntries(Object.entries(variables).filter(([name]) => defined.has(name))));
      });
      const [subject, body] = rendered as [(typeof rendered)[number], (typeof rendered)[number]];
      return { subject: subject.value, html: body.value, text: htmlToPlainText(body.value), templateVersion: `${body.version}` };
    },
  };
}

/**
 * The magic link: the public web origin, the verification page and the token in the URL FRAGMENT (`#token=...`). A fragment is never sent to any server, so
 * the token cannot reach an access log, a trace, a proxy or a Referer header; the page reads it in the browser and the person confirms with a button
 * (opening the link never verifies anything, so a mail scanner that prefetches it changes nothing). The token is a one-time credential with 256 bits of
 * entropy, valid for minutes.
 */
export const createVerificationLinkBuilder =
  (webPublicUrl: string) =>
  (token: string): string =>
    `${webPublicUrl.replace(/\/$/, '')}/verify-email#token=${encodeURIComponent(token)}`;
