// Pure helpers of the device registry (ID-004, docs/engineering/SESSIONS_AND_MFA.md): the closed-vocabulary user agent classifier and the keyed hash of the
// device secret. No I/O, no clock, no logging. Nothing returned here carries the user agent or the device secret: the classifier output is three coarse families.
import {
  BROWSER_FAMILIES,
  DEVICE_CLASSES,
  DEVICE_SECRET_SHAPE,
  OS_FAMILIES,
  USER_AGENT_MAX_LENGTH,
  type BrowserFamily,
  type DeviceClass,
  type DeviceSummaryDto,
  type OsFamily,
} from '@bananagig/contracts';
import { hmacHex } from './verification-crypto';

export const DEVICE_HASH_DOMAIN = 'bananagig:device:v1';

/**
 * The keyed hash stored for a device: HMAC-SHA-256 (hex) over the domain, the ACCOUNT id and the device secret, length-prefixed (injective, like every hash in
 * verification-crypto.ts). Binding the account means one browser has a different hash on every account, and a database leak yields no usable cookie.
 */
export const hashDeviceSecret = (hashSecret: string, accountId: string, deviceSecret: string): string =>
  hmacHex(hashSecret, DEVICE_HASH_DOMAIN, accountId, deviceSecret);

/** Whether a value has the shape of a device secret (43 base64url characters = 32 random bytes). */
export const isDeviceSecretShape = (v: unknown): v is string => typeof v === 'string' && DEVICE_SECRET_SHAPE.test(v);

const UNKNOWN: DeviceSummaryDto = { browser: 'OTHER', os: 'OTHER', deviceClass: 'OTHER' };

/**
 * Reduces a user agent to three coarse families and forgets the rest. The classifier is deliberately small and ordered: a browser that embeds another's token
 * (Edge and Opera contain "Chrome", Chrome contains "Safari") is recognised by its own token first. Anything unrecognised, empty, non-string or absurdly long is
 * OTHER. Bounded work: only the first USER_AGENT_MAX_LENGTH characters are looked at. The result is always a member of the closed vocabularies of the database.
 */
export function classifyUserAgent(userAgent: unknown): DeviceSummaryDto {
  if (typeof userAgent !== 'string') return { ...UNKNOWN };
  const ua = userAgent.slice(0, USER_AGENT_MAX_LENGTH);
  if (ua.trim() === '') return { ...UNKNOWN };

  let browser: BrowserFamily = 'OTHER';
  if (/\b(?:Edg|EdgA|EdgiOS|Edge)\//.test(ua)) browser = 'EDGE';
  else if (/\b(?:OPR|OPiOS|Opera)\b/.test(ua)) browser = 'OPERA';
  else if (/\bSamsungBrowser\//.test(ua)) browser = 'OTHER';
  else if (/\b(?:Firefox|FxiOS)\//.test(ua)) browser = 'FIREFOX';
  else if (/\b(?:Chrome|CriOS|Chromium)\//.test(ua)) browser = 'CHROME';
  else if (/\bVersion\/[\d.]+.*\bSafari\//.test(ua)) browser = 'SAFARI';

  let os: OsFamily = 'OTHER';
  if (/\b(?:iPhone|iPad|iPod)\b/.test(ua)) os = 'IOS';
  else if (/\bWindows Phone\b/.test(ua))
    os = 'WINDOWS'; // Windows Phone user agents also say "Android"
  else if (/\bAndroid\b/.test(ua)) os = 'ANDROID';
  else if (/\bWindows NT\b/.test(ua)) os = 'WINDOWS';
  else if (/\b(?:Macintosh|Mac OS X)\b/.test(ua)) os = 'MACOS';
  else if (/\bCrOS\b/.test(ua)) os = 'OTHER';
  else if (/\b(?:Linux|X11)\b/.test(ua)) os = 'LINUX';

  let deviceClass: DeviceClass = 'OTHER';
  if (/\b(?:iPad|Tablet)\b/.test(ua)) deviceClass = 'TABLET';
  else if (/\b(?:iPhone|iPod|Mobile|Mobi|Windows Phone|Opera Mini)\b/.test(ua)) deviceClass = 'MOBILE';
  else if (os === 'ANDROID')
    deviceClass = 'TABLET'; // Android without the "Mobile" token is a tablet
  else if (os === 'WINDOWS' || os === 'MACOS' || os === 'LINUX') deviceClass = 'DESKTOP';

  return { browser, os, deviceClass };
}

// the vocabularies of the classifier are those of the contracts (and of the CHECK constraints of migration 0012); exported for tests and completeness checks
export const DEVICE_VOCABULARIES = { browsers: BROWSER_FAMILIES, operatingSystems: OS_FAMILIES, classes: DEVICE_CLASSES } as const;
