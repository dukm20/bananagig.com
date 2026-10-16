// The device cookie (ID-004): an opaque random secret that lets the API recognise this browser across logins (the trusted-browser list). It identifies a BROWSER, never a
// person or a session, and grants nothing: the API keeps only a keyed hash of it, and a stolen value cannot sign anyone in.
//
//  - HttpOnly + SameSite=Lax always, `Secure` and the `__Host-` prefix on https (see cookies.ts / runtime.ts), Path=/, no Domain: script never reads it.
//  - It is minted here, sent to the API in a request BODY at login (`POST /account/security/sessions/current`) and nowhere else: never in Valkey, the session record,
//    a log line, a URL or a redirect.
import { randomToken } from '@bananagig/identity';
import { DEVICE_SECRET_SHAPE, USER_AGENT_MAX_LENGTH } from '@bananagig/contracts';
import { clearCookie, parseCookies, serializeCookie } from './cookies';
import type { AuthConfig } from './types';

/** 400 days: the longest lifetime browsers honour for a cookie. A technical ceiling, not a business value (the trusted window lives in the API's configuration). */
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

export interface DeviceSecret {
  /** The secret to register with the API (43 base64url characters). */
  secret: string;
  /** The Set-Cookie header value to send: issues a new secret or renews the lifetime of the one the browser already holds. */
  setCookie: string;
  /** True when this browser had no (valid) device cookie and the secret was just minted. */
  minted: boolean;
}

/** A new device secret and the cookie that carries it (used when the browser's own secret belongs to a removed device). */
export function mintDeviceSecret(cfg: Pick<AuthConfig, 'deviceCookie' | 'cookieSecure'>): DeviceSecret {
  const secret = randomToken(32);
  return { secret, minted: true, setCookie: deviceCookieValue(secret, cfg) };
}

/** The Set-Cookie value of a device secret. */
export const deviceCookieValue = (secret: string, cfg: Pick<AuthConfig, 'deviceCookie' | 'cookieSecure'>): string =>
  serializeCookie(cfg.deviceCookie, secret, { maxAgeSeconds: DEVICE_COOKIE_MAX_AGE_SECONDS, path: '/', secure: cfg.cookieSecure });

/** Set-Cookie value that removes the device cookie. */
export const clearDeviceCookie = (cfg: Pick<AuthConfig, 'deviceCookie' | 'cookieSecure'>): string => clearCookie(cfg.deviceCookie, '/', cfg.cookieSecure);

/** The browser's device secret from the request, or a freshly minted one when it has none (or a malformed one: a tampered cookie is replaced, never trusted). */
export function ensureDeviceSecret(req: Request, cfg: Pick<AuthConfig, 'deviceCookie' | 'cookieSecure'>): DeviceSecret {
  const held = parseCookies(req.headers.get('cookie'))[cfg.deviceCookie];
  const minted = held === undefined || !DEVICE_SECRET_SHAPE.test(held);
  const secret = minted ? randomToken(32) : held;
  return {
    secret,
    minted,
    setCookie: deviceCookieValue(secret, cfg),
  };
}

/** The user agent the API reduces to a coarse browser/OS/device class and discards (bounded; undefined when the browser sent none). */
export function userAgentOf(req: Request): string | undefined {
  const ua = req.headers.get('user-agent')?.trim();
  return ua ? ua.slice(0, USER_AGENT_MAX_LENGTH) : undefined;
}
