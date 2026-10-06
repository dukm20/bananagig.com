export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds: number;
  path: string;
  secure: boolean;
}

/** HttpOnly + SameSite=Lax always. Lax (not Strict) so the cookie accompanies the top-level redirect back from Keycloak. */
export function serializeCookie(name: string, value: string, o: CookieOptions): string {
  return [`${name}=${value}`, `Path=${o.path}`, `Max-Age=${o.maxAgeSeconds}`, 'HttpOnly', 'SameSite=Lax', ...(o.secure ? ['Secure'] : [])].join('; ');
}

export const clearCookie = (name: string, path: string, secure: boolean): string => serializeCookie(name, '', { maxAgeSeconds: 0, path, secure });
