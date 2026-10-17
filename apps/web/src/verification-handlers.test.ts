// TRUST-001 web side, part 1: the BFF half of provider verification. The POST handlers behind /provider/verification (open, upload, withdraw, submit, cancel, reverify) and
// the Next route module in front of them. The API is a fake client factory with spies and the object store is a REAL local HTTP server (127.0.0.1, ephemeral port); the global
// `fetch` is a spy that must never be called for the PUT (Next.js traces fetch with the full URL, which carries the signature): what matters is WHICH call is made,
// with WHAT, in which ORDER (authorize -> PUT to the one-time URL -> finalize), that nothing but a well-formed form reaches the API (the server decides everything else),
// that a result is a fixed 303 target, and that no uploaded value (file name, bytes, type), one-time URL, token or log line leaks.
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TRUST_DOCUMENT_SIZE_CEILING, TRUST_ERROR_CODES } from '@bananagig/contracts';
import { GET as verificationGet, POST as verificationPost } from './app/auth/provider/verification/[action]/route';
import { ApiError } from './lib/api-client';
import {
  VERIFICATION_ACTIONS,
  VERIFICATION_API_ERROR_CODES,
  VERIFICATION_GENERIC_ERROR,
  VERIFICATION_NOTICES,
  handleVerificationAction,
  isVerificationAction,
  type VerificationAction,
} from './lib/auth/verification-handlers';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthConfig, AuthDeps, SessionRecord } from './lib/auth/types';
import { documentDto, uploadAuthorizationDto, verificationDto } from './testing/verification-stub';

const routeState = vi.hoisted(() => ({ deps: undefined as unknown, calls: 0 }));
vi.mock('./lib/auth/runtime', () => ({
  authDeps: () => {
    routeState.calls++;
    return routeState.deps;
  },
}));

const PUBLIC = 'http://app.localhost:8080';
const cfg: AuthConfig = {
  clientId: 'bananagig-web',
  webOrigin: new URL(PUBLIC).origin,
  webPublicUrl: PUBLIC,
  redirectUri: `${PUBLIC}/auth/callback`,
  postLogoutRedirectUri: `${PUBLIC}/`,
  endpoints: {
    authorization: 'http://auth.localhost:8080/realms/bananagig/protocol/openid-connect/auth',
    endSession: 'http://auth.localhost:8080/realms/bananagig/protocol/openid-connect/logout',
    token: 'http://keycloak-auth:8080/realms/bananagig/protocol/openid-connect/token',
  },
  cookieSecure: false,
  sessionCookie: 'bg_session',
  txCookie: 'bg_auth_tx',
  deviceCookie: 'bg_device',
  revokedRedirectUri: `${PUBLIC}/session?error=session_revoked`,
};
const TOKENS = { access: 'tok-access-SECRET-1', refresh: 'tok-refresh-SECRET-2', id: 'tok-id-SECRET-3' }; // secret-scan:allow (fake test fixtures)
const SESSION_COOKIE = 'bg_session=sid-1';
const apiError = (status: number, code: string, details?: Record<string, unknown>, message = code): ApiError =>
  new ApiError(status, code, 'TEST', message, 'corr-1', details);
const VIEW = verificationDto();
/** The ceiling the handler applies before it reads an upload body: the structural file ceiling plus room for the other fields and the multipart framing. */
const MAX_REQUEST_BYTES = TRUST_DOCUMENT_SIZE_CEILING + 65_536;
const DOC_ID = '0b7e3d52-8c41-4f6a-b9d0-2e5a1c7f4d83';
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00, 0xff, 0xfe, 0x31, 0x0a]); // %PDF-1.4 plus binary bytes (synthetic)

const FN_NAMES = [
  'openProviderVerification',
  'requestVerificationUpload',
  'finalizeVerificationDocument',
  'withdrawVerificationDocument',
  'submitProviderVerification',
  'cancelProviderVerification',
  'reverifyProviderRequirement',
] as const;
type FnName = (typeof FN_NAMES)[number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fns = Record<FnName | 'setActiveRole' | 'getProviderVerification', Mock<(...args: any[]) => Promise<any>>>;
interface Harness {
  deps: AuthDeps;
  store: MemorySessionStore;
  fns: Fns;
  apiTokens: string[];
  logs: string[];
  /** The calls to the API and to the object store, in order. */
  order: string[];
}
function harness(withApi = true): Harness {
  const store = new MemorySessionStore();
  const apiTokens: string[] = [];
  const logs: string[] = [];
  const order: string[] = [];
  const tracked = <T>(name: string, value: T) =>
    vi.fn(async () => {
      order.push(name);
      return value;
    });
  const fns: Fns = {
    setActiveRole: vi.fn(async () => {
      throw new Error('the role switch is not part of the verification actions');
    }),
    getProviderVerification: vi.fn(async () => VIEW),
    openProviderVerification: tracked('openProviderVerification', { created: true, verification: VIEW }),
    requestVerificationUpload: vi.fn(async () => {
      order.push('requestVerificationUpload');
      return uploadAuthorizationDto({ url: uploadUrl() });
    }),
    finalizeVerificationDocument: tracked('finalizeVerificationDocument', documentDto()),
    withdrawVerificationDocument: tracked('withdrawVerificationDocument', documentDto({ status: 'WITHDRAWN' })),
    submitProviderVerification: tracked('submitProviderVerification', VIEW),
    cancelProviderVerification: tracked('cancelProviderVerification', VIEW),
    reverifyProviderRequirement: tracked('reverifyProviderRequirement', VIEW),
  };
  const deps = {
    cfg,
    store,
    verifier: {},
    now: () => Math.floor(Date.now() / 1000),
    log: (level: string, message: string, attrs?: Record<string, unknown>) => void logs.push(JSON.stringify({ level, message, ...attrs })),
    ...(withApi
      ? {
          api: (accessToken: string) => {
            apiTokens.push(accessToken);
            return fns as unknown as ReturnType<NonNullable<AuthDeps['api']>>;
          },
        }
      : {}),
  } as unknown as AuthDeps;
  return { deps, store, fns, apiTokens, logs, order };
}
const seed = (h: Harness, over: Partial<SessionRecord> = {}): SessionRecord => {
  const record: SessionRecord = {
    subject: 'user-1',
    realmRoles: ['customer'],
    accessToken: TOKENS.access,
    refreshToken: TOKENS.refresh,
    idToken: TOKENS.id,
    accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    createdAt: Math.floor(Date.now() / 1000),
    ...over,
  };
  h.store.sessions.set('sid-1', record);
  return record;
};

// ---- the object store: a REAL local HTTP server. The handler PUTs the bytes to the one-time URL from the server with node:http(s); the global fetch is a spy that must stay unused.
type Behavior = { status: number; body?: string; headers?: Record<string, string> } | 'destroy' | 'hang';
interface Received {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  /** The header names exactly as they were sent (lower case), in order. */
  names: string[];
  body: Buffer;
}
const target = { server: undefined as http.Server | undefined, port: 0, received: [] as Received[], script: [] as Behavior[], sockets: new Set<Socket>() };
/** What follows the host in the authorized URL: a path below the private bucket and a signature in the query (both must reach the store untouched). */
const UPLOAD_PATH = '/private/trust/upload/one-time-object?X-Signature=ONE-TIME-SIGNATURE-VALUE&X-Expires=300';
const uploadUrl = (): string => `http://127.0.0.1:${target.port}${UPLOAD_PATH}`;
let fetchMock: Mock<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>;
let currentOrder: string[] = [];
beforeAll(async () => {
  target.server = http.createServer((req, res) => {
    currentOrder.push('PUT');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      target.received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        names: req.rawHeaders.filter((_v, i) => i % 2 === 0).map((n) => n.toLowerCase()),
        body: Buffer.concat(chunks),
      });
      const b = target.script.shift() ?? { status: 200 };
      if (b === 'destroy') req.socket.destroy();
      else if (b === 'hang') return;
      else {
        res.writeHead(b.status, { connection: 'close', ...b.headers });
        res.end(b.body);
      }
    });
  });
  target.server.on('connection', (socket) => {
    target.sockets.add(socket);
    socket.on('close', () => target.sockets.delete(socket));
  });
  await new Promise<void>((resolve) => target.server!.listen(0, '127.0.0.1', resolve));
  target.port = (target.server.address() as AddressInfo).port;
});
afterAll(async () => {
  for (const socket of target.sockets) socket.destroy();
  await new Promise<void>((resolve) => target.server!.close(() => resolve()));
});
beforeEach(() => {
  fetchMock = vi.fn(async () => {
    throw new Error('the global fetch must not be used to hand the file to the object store');
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  target.received.length = 0;
  target.script.length = 0;
  for (const socket of target.sockets) socket.destroy();
});
const newHarness = (withApi = true): Harness => {
  const h = harness(withApi);
  currentOrder = h.order;
  return h;
};

// ---- requests
const pairs = (...entries: Array<[string, string]>): URLSearchParams => new URLSearchParams(entries);
const pdfFile = (name = 'evidence.pdf', type = 'application/pdf', bytes: Uint8Array = PDF_BYTES): File => new File([bytes as BlobPart], name, { type });
const uploadForm = (
  over: { requirementCode?: string | null; documentTypeCode?: string | null; file?: File | null; extra?: Array<[string, string | File]> } = {},
): FormData => {
  const fd = new FormData();
  const requirementCode = over.requirementCode === undefined ? 'identity_verification' : over.requirementCode;
  const documentTypeCode = over.documentTypeCode === undefined ? 'passport' : over.documentTypeCode;
  if (requirementCode !== null) fd.append('requirementCode', requirementCode);
  if (documentTypeCode !== null) fd.append('documentTypeCode', documentTypeCode);
  const file = over.file === undefined ? pdfFile() : over.file;
  if (file !== null) fd.append('file', file);
  for (const [k, v] of over.extra ?? []) fd.append(k, v);
  return fd;
};
const BODIES: Record<VerificationAction, () => BodyInit> = {
  open: () => pairs(),
  upload: () => uploadForm(),
  withdraw: () => pairs(['documentId', DOC_ID]),
  submit: () => pairs(['expectedRevision', '4']),
  cancel: () => pairs(),
  reverify: () => pairs(['requirementCode', 'identity_verification']),
};
/** Which API methods each action calls, in order. */
const CALLS: Record<VerificationAction, FnName[]> = {
  open: ['openProviderVerification'],
  upload: ['requestVerificationUpload', 'finalizeVerificationDocument'],
  withdraw: ['withdrawVerificationDocument'],
  submit: ['submitProviderVerification'],
  cancel: ['cancelProviderVerification'],
  reverify: ['reverifyProviderRequirement'],
};
/** The call whose failure ends the action early (the first one). */
const FIRST: Record<VerificationAction, FnName> = {
  open: 'openProviderVerification',
  upload: 'requestVerificationUpload',
  withdraw: 'withdrawVerificationDocument',
  submit: 'submitProviderVerification',
  cancel: 'cancelProviderVerification',
  reverify: 'reverifyProviderRequirement',
};
type PostOptions = { method?: string; origin?: string | null; cookie?: string | null; headers?: Record<string, string>; contentLength?: string | null };
/** A request whose body is serialized like a browser would (a FormData becomes real multipart bytes); the content-length is the real one unless the test overrides it. */
const build = async (path: string, body: BodyInit | null, o: PostOptions = {}): Promise<Request> => {
  const method = o.method ?? 'POST';
  let payload: BodyInit | null = body;
  const headers: Record<string, string> = {};
  let length: number | undefined;
  if (body instanceof FormData) {
    const r = new Response(body);
    const buf = new Uint8Array(await r.arrayBuffer());
    payload = buf;
    headers['content-type'] = r.headers.get('content-type')!;
    length = buf.byteLength;
  } else if (body instanceof URLSearchParams || typeof body === 'string') {
    length = new TextEncoder().encode(String(body)).byteLength;
  }
  if (o.contentLength === undefined) {
    if (length !== undefined) headers['content-length'] = String(length);
  } else if (o.contentLength !== null) headers['content-length'] = o.contentLength;
  return new Request(`http://web-app:3000${path}`, {
    method,
    headers: {
      ...(o.origin === null ? {} : { origin: o.origin ?? PUBLIC }),
      ...(o.cookie === null ? {} : { cookie: o.cookie ?? SESSION_COOKIE }),
      ...headers,
      ...o.headers,
    },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: payload }),
  });
};
const action = async (h: Harness, name: VerificationAction, body: BodyInit | null = BODIES[name](), o: PostOptions = {}) =>
  handleVerificationAction(await build(`/auth/provider/verification/${name}`, body, o), h.deps, name);
const noApiCalls = (h: Harness): void => {
  for (const [name, fn] of Object.entries(h.fns)) expect(fn, name).not.toHaveBeenCalled();
  expect(fetchMock, 'the global fetch').not.toHaveBeenCalled();
  expect(target.received, 'the object store').toEqual([]);
};
const seen = async (res: Response): Promise<string> =>
  [res.headers.get('location'), ...[...res.headers].map(([k, v]) => `${k}: ${v}`), await res.text()].join('\n');
const expectBack = (res: Response, query: string): void => {
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe(`${PUBLIC}/provider/verification${query}`);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.body).toBeNull();
  expect(res.headers.getSetCookie()).toEqual([]);
};
const expectBadRequest = async (res: Response): Promise<void> => {
  expect(res.status).toBe(400);
  expect(res.headers.get('location')).toBeNull();
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(await res.text()).toBe('Bad request'); // a fixed body: nothing submitted is echoed
};
const logged = (h: Harness): Array<Record<string, unknown>> => h.logs.map((l) => JSON.parse(l) as Record<string, unknown>);

describe('VERIFICATION_ACTIONS and isVerificationAction', () => {
  it('names exactly the six actions and the seven notice words', () => {
    expect([...VERIFICATION_ACTIONS]).toEqual(['open', 'upload', 'withdraw', 'submit', 'cancel', 'reverify']);
    expect([...VERIFICATION_NOTICES]).toEqual(['opened', 'resumed', 'uploaded', 'withdrawn', 'submitted', 'cancelled', 'reverified']);
  });
  it('accepts each action and nothing else', () => {
    for (const a of VERIFICATION_ACTIONS) expect(isVerificationAction(a)).toBe(true);
    for (const other of [
      '',
      'OPEN',
      'open ',
      '/open',
      'open/x',
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'approve',
      'download',
      'reject',
      'external',
      'go-live',
    ])
      expect(isVerificationAction(other), other).toBe(false);
  });
  it('the error codes a redirect may carry are exactly the API codes of the trust errors, prefixed TRUST_', () => {
    expect([...VERIFICATION_API_ERROR_CODES]).toEqual(TRUST_ERROR_CODES.map((c) => `TRUST_${c}`));
    expect(VERIFICATION_API_ERROR_CODES).toHaveLength(25);
    expect(VERIFICATION_GENERIC_ERROR).toBe('API_ERROR');
  });
});

describe('verification actions: transport and authentication', () => {
  it.each(VERIFICATION_ACTIONS)('%s: refuses every method but POST (405) and calls nothing (no GET ever changes state)', async (name) => {
    const h = newHarness();
    seed(h);
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']) {
      const res = await handleVerificationAction(await build(`/auth/provider/verification/${name}`, null, { method }), h.deps, name);
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    noApiCalls(h);
  });
  it.each(VERIFICATION_ACTIONS)('%s: refuses a missing, foreign or look-alike Origin (CSRF, 403) before it reads anything', async (name) => {
    const h = newHarness();
    seed(h);
    for (const origin of [
      null,
      'null',
      'http://evil.example',
      'http://app.localhost:9999',
      'https://app.localhost:8080',
      'http://app.localhost:8080.evil.example',
      `${PUBLIC}/`,
      PUBLIC.toUpperCase(),
    ]) {
      const res = await action(h, name, undefined, { origin });
      expect(res.status, String(origin)).toBe(403);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    noApiCalls(h);
    expect(h.store.sessions.size).toBe(1);
  });
  it.each(VERIFICATION_ACTIONS)('%s: a signed-out browser is sent to /session and neither the API nor the object store is called', async (name) => {
    const h = newHarness();
    for (const cookie of [null, 'bg_session=unknown-sid', 'other=1']) {
      const res = await action(h, name, undefined, { cookie });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`${PUBLIC}/session`);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    noApiCalls(h);
    expect(h.apiTokens).toEqual([]);
  });
  it('the origin is checked before the session and the session before the upload size: a foreign origin is 403 and a signed-out upload without a length is only sent to /session', async () => {
    const h = newHarness();
    expect((await action(h, 'upload', undefined, { origin: 'http://evil.example', cookie: null })).status).toBe(403);
    const res = await action(h, 'upload', undefined, { cookie: null, contentLength: null });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${PUBLIC}/session`);
    const huge = await action(h, 'upload', undefined, { cookie: null, contentLength: String(MAX_REQUEST_BYTES + 1) });
    expect(huge.status).toBe(303);
    noApiCalls(h);
  });
  it('refuses to run without an API client (a wiring error, not a request error)', async () => {
    const h = newHarness(false);
    seed(h);
    await expect(action(h, 'open')).rejects.toThrow('AuthDeps.api');
  });
  it.each(VERIFICATION_ACTIONS)('%s: a client without the verification calls is a wiring error too', async (name) => {
    const h = newHarness();
    seed(h);
    const bare = { ...h.deps, api: () => ({ setActiveRole: h.fns.setActiveRole }) } as unknown as AuthDeps;
    await expect(handleVerificationAction(await build(`/auth/provider/verification/${name}`, BODIES[name]()), bare, name)).rejects.toThrow(
      'verification calls',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(FN_NAMES)('a client lacking only %s is a wiring error for every action (the check covers each call)', async (missing) => {
    const h = newHarness();
    seed(h);
    const partial = { ...h.fns, [missing]: undefined };
    const deps = { ...h.deps, api: () => partial } as unknown as AuthDeps;
    for (const name of VERIFICATION_ACTIONS)
      await expect(handleVerificationAction(await build(`/auth/provider/verification/${name}`, BODIES[name]()), deps, name), name).rejects.toThrow(
        'verification calls',
      );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('verification actions: what each one asks of the API', () => {
  it('open: no arguments but the role, a created case says "opened"', async () => {
    const h = newHarness();
    seed(h, { activeRole: 'CUSTOMER' });
    expectBack(await action(h, 'open'), '?notice=opened');
    expect(h.fns.openProviderVerification).toHaveBeenCalledTimes(1);
    expect(h.fns.openProviderVerification.mock.calls[0]).toEqual([{ activeRole: 'CUSTOMER' }]);
    expect(h.apiTokens).toEqual([TOKENS.access]);
  });
  it('open: a resumed live case (created: false) says "resumed"', async () => {
    const h = newHarness();
    seed(h);
    h.fns.openProviderVerification.mockResolvedValueOnce({ created: false, verification: VIEW });
    expectBack(await action(h, 'open'), '?notice=resumed');
  });
  it('withdraw: forwards exactly the document id with the role and says "withdrawn"', async () => {
    const h = newHarness();
    seed(h, { activeRole: 'PROVIDER' });
    expectBack(await action(h, 'withdraw'), '?notice=withdrawn');
    expect(h.fns.withdrawVerificationDocument.mock.calls).toEqual([[DOC_ID, { activeRole: 'PROVIDER' }]]);
  });
  it('submit: forwards exactly the revision as a number with the role and says "submitted"', async () => {
    const h = newHarness();
    seed(h, { activeRole: 'CUSTOMER' });
    expectBack(await action(h, 'submit'), '?notice=submitted');
    expect(h.fns.submitProviderVerification.mock.calls).toEqual([[{ expectedRevision: 4 }, { activeRole: 'CUSTOMER' }]]);
    expect(typeof (h.fns.submitProviderVerification.mock.calls[0]![0] as { expectedRevision: unknown }).expectedRevision).toBe('number');
  });
  it('cancel: sends no input at all (no reason, no id), only the role, and says "cancelled"', async () => {
    const h = newHarness();
    seed(h, { activeRole: 'PROVIDER' });
    expectBack(await action(h, 'cancel'), '?notice=cancelled');
    expect(h.fns.cancelProviderVerification.mock.calls).toEqual([[{ activeRole: 'PROVIDER' }]]);
  });
  it('reverify: forwards exactly the requirement code with the role and says "reverified"', async () => {
    const h = newHarness();
    seed(h, { activeRole: 'PROVIDER' });
    expectBack(await action(h, 'reverify', pairs(['requirementCode', 'liability_insurance'])), '?notice=reverified');
    expect(h.fns.reverifyProviderRequirement.mock.calls).toEqual([['liability_insurance', { activeRole: 'PROVIDER' }]]);
  });
  it.each(VERIFICATION_ACTIONS)('%s: calls exactly its own API methods in order and no other, and never reads the verification', async (name) => {
    const h = newHarness();
    seed(h);
    await action(h, name);
    expect(h.order.filter((o) => o !== 'PUT')).toEqual(CALLS[name]);
    for (const [other, fn] of Object.entries(h.fns)) {
      if (CALLS[name].includes(other as FnName)) expect(fn, other).toHaveBeenCalledTimes(1);
      else expect(fn, other).not.toHaveBeenCalled();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(target.received).toHaveLength(name === 'upload' ? 1 : 0);
  });
  it.each(VERIFICATION_ACTIONS)('%s: the session token and the active role reach every API call', async (name) => {
    const h = newHarness();
    seed(h, { activeRole: 'PROVIDER' });
    await action(h, name);
    expect(h.apiTokens).toEqual([TOKENS.access]);
    for (const fn of CALLS[name]) {
      const call = h.fns[fn].mock.calls[0]!;
      expect(call[call.length - 1], fn).toEqual({ activeRole: 'PROVIDER' });
    }
  });
  it('sends no active role when the session remembers none', async () => {
    const h = newHarness();
    seed(h);
    await action(h, 'open');
    expect(h.fns.openProviderVerification.mock.calls[0]![0]).toEqual({ activeRole: undefined });
  });
  it('the revision of the form is not required to be the current one: staleness is the SERVER decision (STALE_CASE comes back as a code)', async () => {
    const h = newHarness();
    seed(h);
    h.fns.submitProviderVerification.mockRejectedValueOnce(apiError(409, 'TRUST_STALE_CASE'));
    expectBack(await action(h, 'submit', pairs(['expectedRevision', '1'])), '?error=TRUST_STALE_CASE');
    expect(h.fns.submitProviderVerification).toHaveBeenCalledWith({ expectedRevision: 1 }, expect.anything());
  });
  it("a well-formed form that the server will refuse is the SERVER's decision: it is forwarded unchanged and the refusal comes back as a code", async () => {
    const h = newHarness();
    seed(h);
    h.fns.reverifyProviderRequirement.mockRejectedValueOnce(apiError(409, 'TRUST_NOT_REVERIFIABLE'));
    expectBack(await action(h, 'reverify', pairs(['requirementCode', 'no_such_requirement'])), '?error=TRUST_NOT_REVERIFIABLE');
    expect(h.fns.reverifyProviderRequirement).toHaveBeenCalledWith('no_such_requirement', expect.anything());
    h.fns.withdrawVerificationDocument.mockRejectedValueOnce(apiError(404, 'TRUST_NOT_FOUND'));
    expectBack(await action(h, 'withdraw', pairs(['documentId', '00000000-0000-4000-8000-000000000000'])), '?error=TRUST_NOT_FOUND');
  });
});

describe('the upload: authorize, hand the bytes to the object store, finalize', () => {
  it('runs the three steps in this order and says "uploaded"', async () => {
    const h = newHarness();
    seed(h, { activeRole: 'PROVIDER' });
    expectBack(await action(h, 'upload'), '?notice=uploaded');
    expect(h.order).toEqual(['requestVerificationUpload', 'PUT', 'finalizeVerificationDocument']);
  });
  it('step 1 asks for exactly {requirementCode, documentTypeCode, mimeType, sizeBytes} with the role', async () => {
    const h = newHarness();
    seed(h, { activeRole: 'PROVIDER' });
    await action(h, 'upload', uploadForm({ requirementCode: 'professional_license', documentTypeCode: 'state_id', file: pdfFile('a.pdf', 'application/pdf') }));
    expect(h.fns.requestVerificationUpload.mock.calls).toEqual([
      [
        { requirementCode: 'professional_license', documentTypeCode: 'state_id', mimeType: 'application/pdf', sizeBytes: PDF_BYTES.byteLength },
        { activeRole: 'PROVIDER' },
      ],
    ]);
    expect(Object.keys(h.fns.requestVerificationUpload.mock.calls[0]![0] as object).sort()).toEqual([
      'documentTypeCode',
      'mimeType',
      'requirementCode',
      'sizeBytes',
    ]);
  });
  it('step 2 PUTs the exact bytes to the authorized URL (path and signature untouched) with ONLY content-type and content-length, and never through the global fetch', async () => {
    const h = newHarness();
    seed(h, { activeRole: 'PROVIDER' });
    h.fns.requestVerificationUpload.mockResolvedValueOnce(
      uploadAuthorizationDto({
        url: uploadUrl(),
        headers: { 'content-type': 'application/pdf', 'x-amz-meta-owner': 'someone', authorization: 'Bearer from-authorization', cookie: 'x=1' },
      }),
    );
    await action(h, 'upload');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(target.received).toHaveLength(1);
    const r = target.received[0]!;
    expect(r.method).toBe('PUT');
    expect(r.url).toBe(UPLOAD_PATH);
    expect(r.headers.host).toBe(`127.0.0.1:${target.port}`);
    // only the two headers the handler chooses (plus the transport's own host and connection); the headers of the authorization are NOT forwarded
    expect(r.names.filter((n) => n !== 'host' && n !== 'connection').sort()).toEqual(['content-length', 'content-type']);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-length']).toBe(String(PDF_BYTES.byteLength));
    expect(r.headers['transfer-encoding']).toBeUndefined();
    expect(r.headers['expect']).toBeUndefined();
    expect([...r.body]).toEqual([...PDF_BYTES]);
  });
  it('the PUT goes through node:http for an http URL (60 s timeout, PUT, only the two headers) and node:https for an https URL', async () => {
    const httpSpy = vi.spyOn(http, 'request');
    const httpsSpy = vi.spyOn(https, 'request');
    const h = newHarness();
    seed(h);
    await action(h, 'upload');
    expect(httpsSpy).not.toHaveBeenCalled();
    expect(httpSpy).toHaveBeenCalledTimes(1);
    const [url, options] = httpSpy.mock.calls[0]! as unknown as [URL, http.RequestOptions];
    expect(String(url)).toBe(uploadUrl());
    expect(options).toEqual({
      method: 'PUT',
      headers: { 'content-type': 'application/pdf', 'content-length': String(PDF_BYTES.byteLength) },
      timeout: 60_000,
    });
    // an https URL uses the https client (here it cannot talk TLS to the plain server: the answer is a refusal, not a plain-text PUT)
    httpSpy.mockClear();
    const h2 = newHarness();
    seed(h2);
    h2.fns.requestVerificationUpload.mockResolvedValueOnce(uploadAuthorizationDto({ url: `https://127.0.0.1:${target.port}${UPLOAD_PATH}` }));
    expectBack(await action(h2, 'upload'), '?error=TRUST_OBJECT_MISSING');
    expect(httpsSpy).toHaveBeenCalledTimes(1);
    expect(httpSpy).not.toHaveBeenCalled();
    expect(h2.fns.finalizeVerificationDocument).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('the PUT carries no session cookie, token or API correlation header (the bearer token never goes to the object store)', async () => {
    const h = newHarness();
    seed(h);
    await action(h, 'upload', undefined, { headers: { 'x-correlation-id': 'corr-123', 'x-active-role': 'PROVIDER' } });
    const r = target.received[0]!;
    expect(JSON.stringify(r.headers)).not.toMatch(/cookie|authorization|bearer|tok-access|x-active-role|corr-123|x-correlation/i);
    expect(r.names).not.toContain('cookie');
    expect(r.names).not.toContain('authorization');
  });
  it('a redirect of the object store is NOT followed: the answer is a refusal and the second URL is never requested', async () => {
    const h = newHarness();
    seed(h);
    for (const status of [301, 302, 303, 307, 308]) {
      target.received.length = 0;
      target.script.push({ status, headers: { location: `http://127.0.0.1:${target.port}/elsewhere?stolen=1` } });
      expectBack(await action(h, 'upload'), '?error=TRUST_OBJECT_MISSING');
      expect(
        target.received.map((r) => r.url),
        String(status),
      ).toEqual([UPLOAD_PATH]);
    }
    expect(h.fns.finalizeVerificationDocument).not.toHaveBeenCalled();
  });
  it('the file type and size are taken from the FILE itself, not from the content-length header or any field', async () => {
    const h = newHarness();
    seed(h);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await action(h, 'upload', uploadForm({ file: pdfFile('x.png', 'image/png', png) }), { contentLength: '99999' });
    expect(h.fns.requestVerificationUpload.mock.calls[0]![0]).toMatchObject({ mimeType: 'image/png', sizeBytes: 11 });
    const r = target.received[0]!;
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['content-length']).toBe('11');
    expect(r.body.byteLength).toBe(11);
  });
  it('the type is forwarded as the file declares it even when the server will refuse it (the policy is the SERVER decision)', async () => {
    const h = newHarness();
    seed(h);
    h.fns.requestVerificationUpload.mockRejectedValueOnce(apiError(400, 'TRUST_MIME_NOT_ALLOWED'));
    expectBack(await action(h, 'upload', uploadForm({ file: pdfFile('x.txt', 'text/plain') })), '?error=TRUST_MIME_NOT_ALLOWED');
    expect(h.fns.requestVerificationUpload.mock.calls[0]![0]).toMatchObject({ mimeType: 'text/plain' });
  });
  it('step 3 finalizes the document the API authorized (its id from the authorization, never from the form) with an empty body and the role', async () => {
    const h = newHarness();
    seed(h, { activeRole: 'CUSTOMER' });
    const authorized = uploadAuthorizationDto({ url: uploadUrl() });
    authorized.document = documentDto({ verificationDocumentId: 'c1a2b3d4-0000-4000-8000-00000000abcd', status: 'UPLOAD_PENDING', scanStatus: 'PENDING' });
    h.fns.requestVerificationUpload.mockResolvedValueOnce(authorized);
    await action(h, 'upload');
    expect(h.fns.finalizeVerificationDocument.mock.calls).toEqual([['c1a2b3d4-0000-4000-8000-00000000abcd', {}, { activeRole: 'CUSTOMER' }]]);
  });
  it.each([200, 201, 204])('a %i answer of the object store is a success: the document is finalized', async (status) => {
    const h = newHarness();
    seed(h);
    target.script.push({ status });
    expectBack(await action(h, 'upload'), '?notice=uploaded');
    expect(h.fns.finalizeVerificationDocument).toHaveBeenCalledTimes(1);
    expect(h.logs).toEqual([]);
  });
  it.each([301, 302, 307, 400, 401, 403, 404, 408, 413, 500, 502, 503])(
    'a %i answer of the object store is TRUST_OBJECT_MISSING, finalize is NOT called, and the log holds the action and the status only',
    async (status) => {
      const h = newHarness();
      seed(h);
      target.script.push({ status, body: '<Error>secret detail of the store</Error>' });
      const res = await action(h, 'upload');
      expectBack(res, '?error=TRUST_OBJECT_MISSING');
      expect(await res.text()).toBe('');
      expect(h.fns.finalizeVerificationDocument).not.toHaveBeenCalled();
      expect(logged(h)).toEqual([{ level: 'warn', message: 'verification upload hand-over refused', action: 'upload', status }]);
      expect(h.logs.join('\n')).not.toContain('secret detail');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  describe('a PUT that cannot be completed', () => {
    /** A port nobody listens on any more. */
    const closedPort = async (): Promise<number> => {
      const s = http.createServer();
      await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
      const port = (s.address() as AddressInfo).port;
      await new Promise<void>((resolve) => s.close(() => resolve()));
      return port;
    };
    const refused = async (h: Harness, res: Response): Promise<void> => {
      expectBack(res, '?error=TRUST_OBJECT_MISSING');
      expect(h.fns.finalizeVerificationDocument).not.toHaveBeenCalled();
      expect(logged(h)).toEqual([{ level: 'warn', message: 'verification upload hand-over refused', action: 'upload', status: 0 }]);
      expect(h.logs.join('\n')).not.toMatch(/127\.0\.0\.1|X-Signature|ONE-TIME|private|ECONN|socket|EPIPE/i);
      expect(await seen(res)).not.toMatch(/127\.0\.0\.1|X-Signature|ONE-TIME/i);
      expect(fetchMock).not.toHaveBeenCalled();
    };
    it('the store closes the connection: TRUST_OBJECT_MISSING, finalize NOT called, no URL or error text in the log or the redirect', async () => {
      const h = newHarness();
      seed(h);
      target.script.push('destroy');
      await refused(h, await action(h, 'upload'));
      expect(target.received).toHaveLength(1);
    });
    it('the store is not reachable (connection refused)', async () => {
      const h = newHarness();
      seed(h);
      h.fns.requestVerificationUpload.mockResolvedValueOnce(uploadAuthorizationDto({ url: `http://127.0.0.1:${await closedPort()}${UPLOAD_PATH}` }));
      await refused(h, await action(h, 'upload'));
    });
    it('the request times out (the 60 s socket timeout fires): the PUT is destroyed and refused', async () => {
      const spy = vi.spyOn(http, 'request');
      const h = newHarness();
      seed(h);
      target.script.push('hang');
      const pending = action(h, 'upload');
      await vi.waitFor(() => expect(target.received).toHaveLength(1), { timeout: 10_000 });
      (spy.mock.results[0]!.value as http.ClientRequest).emit('timeout');
      await refused(h, await pending);
    });
    it.each([
      ['a file: URL', 'file:///etc/passwd'],
      ['an ftp: URL', 'ftp://127.0.0.1/x'],
      ['a data: URL', 'data:text/plain;base64,AAAA'],
      ['a javascript: URL', 'javascript:alert(1)'],
      ['a ws: URL', 'ws://127.0.0.1/x'],
      ['something that is not a URL', 'not a url'],
      ['an empty URL', ''],
    ])('%s is never requested: it speaks only http and https', async (_n, url) => {
      const httpSpy = vi.spyOn(http, 'request');
      const httpsSpy = vi.spyOn(https, 'request');
      const h = newHarness();
      seed(h);
      h.fns.requestVerificationUpload.mockResolvedValueOnce(uploadAuthorizationDto({ url }));
      const res = await action(h, 'upload');
      expectBack(res, '?error=TRUST_OBJECT_MISSING');
      expect(httpSpy).not.toHaveBeenCalled();
      expect(httpsSpy).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(h.fns.finalizeVerificationDocument).not.toHaveBeenCalled();
      expect(logged(h)).toEqual([{ level: 'warn', message: 'verification upload hand-over refused', action: 'upload', status: 0 }]);
    });
  });
  it('an ApiError while authorizing comes back as its code, nothing is PUT and nothing is finalized', async () => {
    const h = newHarness();
    seed(h);
    h.fns.requestVerificationUpload.mockRejectedValueOnce(apiError(400, 'TRUST_FILE_TOO_LARGE'));
    expectBack(await action(h, 'upload'), '?error=TRUST_FILE_TOO_LARGE');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(target.received).toEqual([]);
    expect(h.fns.finalizeVerificationDocument).not.toHaveBeenCalled();
    expect(logged(h)).toEqual([{ level: 'warn', message: 'verification action refused', action: 'upload', code: 'TRUST_FILE_TOO_LARGE', status: 400 }]);
  });
  it('an ApiError while finalizing comes back as its code (the bytes were already handed over)', async () => {
    const h = newHarness();
    seed(h);
    h.fns.finalizeVerificationDocument.mockRejectedValueOnce(apiError(400, 'TRUST_SCAN_INFECTED'));
    expectBack(await action(h, 'upload'), '?error=TRUST_SCAN_INFECTED');
    expect(target.received).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged(h)).toEqual([{ level: 'warn', message: 'verification action refused', action: 'upload', code: 'TRUST_SCAN_INFECTED', status: 400 }]);
  });
  it('an error outside the closed list while authorizing or finalizing is API_ERROR', async () => {
    const h = newHarness();
    seed(h);
    h.fns.requestVerificationUpload.mockRejectedValueOnce(new Error('boom'));
    expectBack(await action(h, 'upload'), '?error=API_ERROR');
    h.fns.finalizeVerificationDocument.mockRejectedValueOnce(apiError(500, 'WEIRD'));
    expectBack(await action(h, 'upload'), '?error=API_ERROR');
  });
  it.each(['requestVerificationUpload', 'finalizeVerificationDocument'] as const)(
    '401 SESSION_REVOKED from %s ends the local session through Keycloak',
    async (fn) => {
      const h = newHarness();
      seed(h);
      h.fns[fn].mockRejectedValueOnce(apiError(401, 'SESSION_REVOKED'));
      const res = await action(h, 'upload');
      expect(res.status).toBe(303);
      expect(new URL(res.headers.get('location')!).origin + new URL(res.headers.get('location')!).pathname).toBe(cfg.endpoints.endSession);
      expect(h.store.sessions.size).toBe(0);
      expect(h.logs.join('\n')).not.toContain('verification action refused');
    },
  );
  it('the bytes handed over are the bytes of the file: a binary body with every byte value survives', async () => {
    const h = newHarness();
    seed(h);
    const all = new Uint8Array(256).map((_v, i) => i);
    await action(h, 'upload', uploadForm({ file: pdfFile('all.pdf', 'application/pdf', all) }));
    expect([...target.received[0]!.body]).toEqual([...all]);
    expect(target.received[0]!.headers['content-length']).toBe('256');
    expect(h.fns.requestVerificationUpload.mock.calls[0]![0]).toMatchObject({ sizeBytes: 256 });
  });
});

describe('the upload: size and framing (413 and 400 before anything is read or called)', () => {
  it('requires a content-length: absent, empty, zero, negative, fractional or not a number is 400', async () => {
    for (const contentLength of [null, '', '0', '-1', '-100', '0.5', 'abc', 'NaN', '1 2']) {
      const h = newHarness();
      seed(h);
      const res = await action(h, 'upload', undefined, { contentLength });
      await expectBadRequest(res);
      noApiCalls(h);
    }
  });
  it('a content-length above the ceiling plus the framing allowance is 413 with a fixed body, and the body is NOT read', async () => {
    for (const contentLength of [String(MAX_REQUEST_BYTES + 1), String(MAX_REQUEST_BYTES * 2), '99999999999', '9007199254740993']) {
      const h = newHarness();
      seed(h);
      const req = await build('/auth/provider/verification/upload', uploadForm(), { contentLength });
      const res = await handleVerificationAction(req, h.deps, 'upload');
      expect(res.status, contentLength).toBe(413);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('location')).toBeNull();
      expect(await res.text()).toBe('Payload too large');
      expect(req.bodyUsed, `the body must stay unread for ${contentLength}`).toBe(false);
      noApiCalls(h);
    }
  });
  it('the allowance is the structural ceiling (50 MiB) plus 64 KiB: exactly that is accepted, one more byte is 413', async () => {
    expect(MAX_REQUEST_BYTES).toBe(52_428_800 + 65_536);
    const h = newHarness();
    seed(h);
    expectBack(await action(h, 'upload', undefined, { contentLength: String(MAX_REQUEST_BYTES) }), '?notice=uploaded');
    expectBack(await action(h, 'upload', undefined, { contentLength: '1' }), '?notice=uploaded');
    expect((await action(h, 'upload', undefined, { contentLength: String(MAX_REQUEST_BYTES + 1) })).status).toBe(413);
  });
  it('a file above the structural ceiling that fits the framing allowance is refused by the contract (400) and nothing is called', async () => {
    const h = newHarness();
    seed(h);
    const big = pdfFile('big.pdf', 'application/pdf', new Uint8Array(TRUST_DOCUMENT_SIZE_CEILING + 1));
    await expectBadRequest(await action(h, 'upload', uploadForm({ file: big })));
    noApiCalls(h);
    h.fns.requestVerificationUpload.mockClear();
    const exact = pdfFile('exact.pdf', 'application/pdf', new Uint8Array(TRUST_DOCUMENT_SIZE_CEILING));
    expectBack(await action(h, 'upload', uploadForm({ file: exact })), '?notice=uploaded');
    expect(h.fns.requestVerificationUpload.mock.calls[0]![0]).toMatchObject({ sizeBytes: TRUST_DOCUMENT_SIZE_CEILING });
  }, 30_000);
  it('a zero-byte file is 400 (nothing to verify)', async () => {
    const h = newHarness();
    seed(h);
    await expectBadRequest(await action(h, 'upload', uploadForm({ file: pdfFile('empty.pdf', 'application/pdf', new Uint8Array(0)) })));
    noApiCalls(h);
  });
  it('a file with a type that is not a plain type/subtype is 400 (the type is part of the authorization request)', async () => {
    for (const type of ['application/pdf; charset=utf-8', 'pdf', 'application/', '/pdf', 'application pdf']) {
      const h = newHarness();
      seed(h);
      await expectBadRequest(await action(h, 'upload', uploadForm({ file: pdfFile('x.pdf', type) })));
      noApiCalls(h);
    }
  });
  it('a file without a declared type reaches the API as application/octet-stream (the multipart parser fills it in) and the SERVER refuses it', async () => {
    const h = newHarness();
    seed(h);
    h.fns.requestVerificationUpload.mockRejectedValueOnce(apiError(400, 'TRUST_MIME_NOT_ALLOWED'));
    expectBack(await action(h, 'upload', uploadForm({ file: pdfFile('x.pdf', '') })), '?error=TRUST_MIME_NOT_ALLOWED');
    expect(h.fns.requestVerificationUpload.mock.calls[0]![0]).toMatchObject({ mimeType: 'application/octet-stream' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(target.received).toEqual([]);
  });
  it('a body that is not multipart form data is 400: urlencoded, JSON, garbage with a multipart type, and no body', async () => {
    const h = newHarness();
    seed(h);
    await expectBadRequest(await action(h, 'upload', pairs(['requirementCode', 'identity_verification'], ['documentTypeCode', 'passport'])));
    await expectBadRequest(
      await action(h, 'upload', JSON.stringify({ requirementCode: 'identity_verification', documentTypeCode: 'passport' }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expectBadRequest(await action(h, 'upload', 'not a multipart body', { headers: { 'content-type': 'multipart/form-data; boundary=zzz' } }));
    await expectBadRequest(await action(h, 'upload', null, { contentLength: '10' }));
    noApiCalls(h);
  });
});

describe('verification actions: unknown and malformed form values change nothing (400)', () => {
  const BAD_CODES = [
    '',
    'Identity_Verification',
    'IDENTITY',
    'identity-verification',
    'identity verification',
    'identity_verification\n',
    '_identity',
    'identity_',
    'identity__verification',
    '1identity',
    'identity/../x',
    'identity?x=1',
    '"><script>',
    '../etc',
    'identity.verification',
  ];
  it.each(BAD_CODES)('upload refuses the requirement code %j', async (code) => {
    const h = newHarness();
    seed(h);
    await expectBadRequest(await action(h, 'upload', uploadForm({ requirementCode: code })));
    noApiCalls(h);
  });
  it.each(BAD_CODES)('upload refuses the document type code %j', async (code) => {
    const h = newHarness();
    seed(h);
    await expectBadRequest(await action(h, 'upload', uploadForm({ documentTypeCode: code })));
    noApiCalls(h);
  });
  it.each(BAD_CODES)('reverify refuses the requirement code %j', async (code) => {
    const h = newHarness();
    seed(h);
    await expectBadRequest(await action(h, 'reverify', pairs(['requirementCode', code])));
    noApiCalls(h);
  });
  it('upload applies the contract limits to the codes: a one-letter and an over-long code are 400', async () => {
    const h = newHarness();
    seed(h);
    await expectBadRequest(await action(h, 'upload', uploadForm({ requirementCode: 'a' })));
    await expectBadRequest(await action(h, 'upload', uploadForm({ documentTypeCode: 'a' })));
    await expectBadRequest(await action(h, 'upload', uploadForm({ requirementCode: `a${'b'.repeat(48)}` })));
    await expectBadRequest(await action(h, 'upload', uploadForm({ documentTypeCode: `a${'b'.repeat(48)}` })));
    noApiCalls(h);
    expectBack(await action(h, 'upload', uploadForm({ requirementCode: 'ab', documentTypeCode: `a${'b'.repeat(47)}` })), '?notice=uploaded');
  });
  it('reverify applies the contract limits too: a one-letter code and a 49-character code are 400, 2 and 48 characters are accepted', async () => {
    const h = newHarness();
    seed(h);
    await expectBadRequest(await action(h, 'reverify', pairs(['requirementCode', 'a'])));
    await expectBadRequest(await action(h, 'reverify', pairs(['requirementCode', `a${'b'.repeat(48)}`])));
    noApiCalls(h);
    expectBack(await action(h, 'reverify', pairs(['requirementCode', 'ab'])), '?notice=reverified');
    expectBack(await action(h, 'reverify', pairs(['requirementCode', `a${'b'.repeat(47)}`])), '?notice=reverified');
    expect(h.fns.reverifyProviderRequirement.mock.calls.map((c) => (c[0] as string).length)).toEqual([2, 48]);
  });
  it.each(['identity_verification', 'a1_b2', 'ab', 'x9'])('accepts the well-formed code %j', async (code) => {
    const h = newHarness();
    seed(h);
    expectBack(await action(h, 'reverify', pairs(['requirementCode', code])), '?notice=reverified');
    expect(h.fns.reverifyProviderRequirement).toHaveBeenCalledWith(code, expect.anything());
  });
  const BAD_IDS = [
    '',
    'x',
    DOC_ID.toUpperCase(),
    DOC_ID.replaceAll('-', ''),
    `${DOC_ID}\n`,
    ` ${DOC_ID}`,
    `${DOC_ID}x`,
    `${DOC_ID.slice(0, -1)}g`,
    `../${DOC_ID}`,
    `${DOC_ID}/finalize`,
    `${DOC_ID}?x=1`,
    '"><script>',
    '0b7e3d52-8c41-4f6a-b9d0-2e5a1c7f4d8',
    '0b7e3d52-8c41-4f6a-b9d0-2e5a1c7f4d833',
  ];
  it.each(BAD_IDS)('withdraw refuses the document id %j', async (id) => {
    const h = newHarness();
    seed(h);
    await expectBadRequest(await action(h, 'withdraw', pairs(['documentId', id])));
    noApiCalls(h);
  });
  it('withdraw accepts a lower-case UUID of any version bits and forwards it unchanged', async () => {
    const h = newHarness();
    seed(h);
    expectBack(await action(h, 'withdraw', pairs(['documentId', '00000000-0000-0000-0000-000000000000'])), '?notice=withdrawn');
    expect(h.fns.withdrawVerificationDocument.mock.calls[0]![0]).toBe('00000000-0000-0000-0000-000000000000');
  });
  it.each(['1', '4', '9', '123456789'])('accepts the revision %s (1 to 9 digits, no leading zero)', async (rev) => {
    const h = newHarness();
    seed(h);
    expectBack(await action(h, 'submit', pairs(['expectedRevision', rev])), '?notice=submitted');
    expect(h.fns.submitProviderVerification).toHaveBeenCalledWith({ expectedRevision: Number(rev) }, expect.anything());
  });
  it.each(['', '0', '00', '01', '-1', '+1', '1.5', '1e3', '1234567890', '2147483648', ' 4', '4 ', '4\n', '0x10', 'abc', '４', '4;5'])(
    'submit refuses the malformed revision %j',
    async (rev) => {
      const h = newHarness();
      seed(h);
      await expectBadRequest(await action(h, 'submit', pairs(['expectedRevision', rev])));
      noApiCalls(h);
    },
  );

  // the exact fields of each action: a form carries EXACTLY these, once each, as text (the upload also one file)
  const FIELDS: Record<VerificationAction, Array<[string, string]>> = {
    open: [],
    upload: [
      ['requirementCode', 'identity_verification'],
      ['documentTypeCode', 'passport'],
    ],
    withdraw: [['documentId', DOC_ID]],
    submit: [['expectedRevision', '4']],
    cancel: [],
    reverify: [['requirementCode', 'identity_verification']],
  };
  const OTHER_FIELDS: Array<[string, string]> = [
    ['requirementCode', 'identity_verification'],
    ['documentTypeCode', 'passport'],
    ['documentId', DOC_ID],
    ['expectedRevision', '4'],
    ['accountId', 'a'],
    ['caseId', 'c'],
    ['status', 'APPROVED'],
    ['decision', 'APPROVED'],
    ['reason', 'because'],
    ['mimeType', 'application/pdf'],
    ['sizeBytes', '10'],
    ['sha256', 'a'.repeat(64)],
    ['role', 'ADMIN'],
  ];
  /** A form of the action built from its own fields plus the given extras, as multipart for the upload and urlencoded otherwise. */
  const formOf = (name: VerificationAction, fields: Array<[string, string | File]>): BodyInit => {
    if (name === 'upload' || fields.some(([, v]) => typeof v !== 'string')) {
      const fd = new FormData();
      for (const [k, v] of fields) fd.append(k, v);
      return fd;
    }
    return new URLSearchParams(fields as Array<[string, string]>);
  };
  const withFile = (name: VerificationAction, fields: Array<[string, string | File]>) =>
    name === 'upload' ? [...fields, ['file', pdfFile()] as [string, File]] : fields;
  it.each(VERIFICATION_ACTIONS)('%s: the exact fields form is accepted (control for the refusals below)', async (name) => {
    const h = newHarness();
    seed(h);
    const res = await action(h, name, formOf(name, withFile(name, FIELDS[name])));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/\?notice=/);
  });
  it.each(VERIFICATION_ACTIONS)('%s: a field that is not one of its own is refused, whatever its name', async (name) => {
    for (const extra of OTHER_FIELDS.filter(([k]) => !FIELDS[name].some(([own]) => own === k))) {
      const h = newHarness();
      seed(h);
      await expectBadRequest(await action(h, name, formOf(name, withFile(name, [...FIELDS[name], extra]))));
      noApiCalls(h);
    }
  });
  it.each(VERIFICATION_ACTIONS)('%s: a repeated field is refused (even with the same value)', async (name) => {
    for (const own of FIELDS[name]) {
      for (const again of [own, [own[0], `${own[1]}x`] as [string, string]]) {
        const h = newHarness();
        seed(h);
        await expectBadRequest(await action(h, name, formOf(name, withFile(name, [...FIELDS[name], again]))));
        noApiCalls(h);
      }
    }
  });
  it.each(VERIFICATION_ACTIONS.filter((n) => FIELDS[n].length > 0))('%s: a missing field is refused (each field is required)', async (name) => {
    for (const missing of FIELDS[name]) {
      const h = newHarness();
      seed(h);
      await expectBadRequest(
        await action(
          h,
          name,
          formOf(
            name,
            withFile(
              name,
              FIELDS[name].filter((f) => f !== missing),
            ),
          ),
        ),
      );
      noApiCalls(h);
    }
  });
  it.each(VERIFICATION_ACTIONS.filter((n) => n !== 'upload'))(
    '%s: a file part is refused (only the upload takes a file), as an extra part or in place of a field',
    async (name) => {
      const h = newHarness();
      seed(h);
      await expectBadRequest(await action(h, name, formOf(name, [...FIELDS[name], ['file', pdfFile()]])));
      const named = new FormData();
      for (const [k, v] of FIELDS[name]) named.append(k, v);
      named.append('upload', new Blob(['x']), 'x.txt');
      await expectBadRequest(await action(h, name, named));
      if (FIELDS[name].length > 0) {
        const replaced = new FormData();
        FIELDS[name].forEach(([k], i) => (i === 0 ? replaced.append(k, new Blob(['4']), 'x.txt') : undefined));
        await expectBadRequest(await action(h, name, replaced));
      }
      noApiCalls(h);
    },
  );
  it('upload: the file part is refused as a text field, as a second file, under another name, and in place of a code', async () => {
    const h = newHarness();
    seed(h);
    await expectBadRequest(await action(h, 'upload', uploadForm({ file: null, extra: [['file', 'not a file']] })));
    await expectBadRequest(await action(h, 'upload', uploadForm({ extra: [['file', pdfFile('second.pdf')]] })));
    await expectBadRequest(await action(h, 'upload', uploadForm({ file: null, extra: [['document', pdfFile()]] })));
    await expectBadRequest(await action(h, 'upload', uploadForm({ extra: [['document', pdfFile()]] })));
    await expectBadRequest(await action(h, 'upload', uploadForm({ requirementCode: null, extra: [['requirementCode', pdfFile()]] })));
    await expectBadRequest(await action(h, 'upload', uploadForm({ file: null })));
    noApiCalls(h);
  });
  it('is checked AFTER the session (a signed-out browser is only sent to /session) and AFTER the origin', async () => {
    const h = newHarness();
    const res = await action(h, 'submit', pairs(['expectedRevision', 'garbage']), { cookie: null });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${PUBLIC}/session`);
    seed(h);
    expect((await action(h, 'submit', pairs(['expectedRevision', 'garbage']), { origin: 'http://evil.example' })).status).toBe(403);
    noApiCalls(h);
  });
  it.each(['open', 'cancel', 'withdraw', 'submit', 'reverify'] as const)('%s: a body that is not a form (JSON, empty) is refused', async (name) => {
    const h = newHarness();
    seed(h);
    await expectBadRequest(await action(h, name, JSON.stringify(Object.fromEntries(FIELDS[name])), { headers: { 'content-type': 'application/json' } }));
    if (FIELDS[name].length > 0) await expectBadRequest(await action(h, name, null));
    noApiCalls(h);
  });
});

describe('verification actions: what the API can answer', () => {
  it.each(VERIFICATION_ACTIONS)('%s: 401 SESSION_REVOKED ends the local session through Keycloak', async (name) => {
    const h = newHarness();
    seed(h);
    h.fns[FIRST[name]].mockRejectedValueOnce(apiError(401, 'SESSION_REVOKED'));
    const res = await action(h, name);
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(cfg.endpoints.endSession);
    expect(loc.searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC}/session?error=session_revoked`);
    expect(res.headers.getSetCookie().find((c) => c.startsWith('bg_session='))).toMatch(/Max-Age=0/);
    expect(h.store.sessions.size).toBe(0);
    expect(h.logs.join('\n')).not.toContain('verification action refused'); // a revoked session is not an action failure
  });
  it.each(VERIFICATION_ACTIONS)('%s: every trust code of the API comes back as ?error=TRUST_<code>, and the session stays', async (name) => {
    const h = newHarness();
    seed(h);
    for (const code of TRUST_ERROR_CODES) {
      h.fns[FIRST[name]].mockRejectedValueOnce(apiError(409, `TRUST_${code}`));
      expectBack(await action(h, name), `?error=TRUST_${code}`);
    }
    expect(h.store.sessions.size).toBe(1);
  });
  it.each(VERIFICATION_ACTIONS)('%s: no step-up is required (a STEP_UP_REQUIRED is just an error, never a login round trip)', async (name) => {
    const h = newHarness();
    seed(h);
    h.fns[FIRST[name]].mockRejectedValueOnce(apiError(401, 'STEP_UP_REQUIRED', { requirement: 'MFA' }));
    expectBack(await action(h, name), '?error=API_ERROR');
    expect(h.store.sessions.size).toBe(1);
  });
  it('a code outside the closed list, an unreachable API or a non-API error is reduced to API_ERROR (never echoed)', async () => {
    const h = newHarness();
    seed(h);
    for (const failure of [
      apiError(0, 'API_UNREACHABLE'),
      apiError(403, 'ACCOUNT_SUSPENDED'),
      apiError(400, 'VALIDATION_FAILED'), // without the TRUST_ prefix it is not the API's trust code
      apiError(409, 'STALE_CASE'),
      apiError(409, 'PROVIDER_CONFLICT'),
      apiError(500, 'TRUST_UNKNOWN_THING'),
      apiError(500, 'trust_unavailable'),
      apiError(500, 'TRUST_'),
      apiError(500, 'TRUST_OBJECT_MISSING '),
      apiError(500, 'weird code with spaces'),
      apiError(500, 'X'.repeat(200)),
      apiError(500, 'a=b&c=d'),
      apiError(500, '"><script>'),
      apiError(500, 'TRUST_UNAVAILABLE&x=1'),
      apiError(500, 'TRUST_CONFLICT\n'),
      new Error('internal detail'),
    ]) {
      h.fns.openProviderVerification.mockRejectedValueOnce(failure);
      const res = await action(h, 'open');
      expectBack(res, '?error=API_ERROR');
      expect(await res.text()).toBe('');
    }
    expect(h.logs.join('\n')).not.toContain('internal detail');
    expect(h.logs.join('\n')).not.toContain('script');
  });
  it('a refusal is logged with the action, the closed code and the status only', async () => {
    const h = newHarness();
    seed(h);
    h.fns.submitProviderVerification.mockRejectedValueOnce(apiError(409, 'TRUST_STALE_CASE'));
    await action(h, 'submit');
    h.fns.cancelProviderVerification.mockRejectedValueOnce(apiError(500, 'something odd'));
    await action(h, 'cancel');
    h.fns.openProviderVerification.mockRejectedValueOnce(new Error('boom'));
    await action(h, 'open');
    expect(logged(h)).toEqual([
      { level: 'warn', message: 'verification action refused', action: 'submit', code: 'TRUST_STALE_CASE', status: 409 },
      { level: 'warn', message: 'verification action refused', action: 'cancel', code: 'API_ERROR', status: 500 },
      { level: 'warn', message: 'verification action refused', action: 'open', code: 'API_ERROR' },
    ]);
  });
  it('a success logs nothing', async () => {
    const h = newHarness();
    seed(h);
    for (const name of VERIFICATION_ACTIONS) await action(h, name);
    expect(h.logs).toEqual([]);
  });
  it('no redirect, header, cookie or log line carries an uploaded value, the one-time URL, a submitted value or a token', async () => {
    const h = newHarness();
    seed(h);
    const NAME = 'my-secret-passport-scan-name.pdf';
    const BYTES = 'SECRET-EVIDENCE-BYTES-8675309';
    const SECRET_CODE = 'zz_secret_requirement';
    const SECRET_DOC = 'deadbeef-1111-4222-8333-444455556666';
    const file = () => new File([`%PDF-1.4\n${BYTES}`], NAME, { type: 'application/pdf' });
    const results: Response[] = [];
    results.push(await action(h, 'upload', uploadForm({ requirementCode: SECRET_CODE, file: file() })));
    h.fns.requestVerificationUpload.mockRejectedValueOnce(
      apiError(400, 'TRUST_MIME_NOT_ALLOWED', { file: NAME, bytes: BYTES, url: uploadUrl() }, `bad ${NAME} ${uploadUrl()}`),
    );
    results.push(await action(h, 'upload', uploadForm({ requirementCode: SECRET_CODE, file: file() })));
    target.script.push('destroy');
    results.push(await action(h, 'upload', uploadForm({ requirementCode: SECRET_CODE, file: file() })));
    target.script.push({ status: 403, body: `denied ${uploadUrl()} ${NAME}`, headers: { 'x-leak': uploadUrl() } });
    results.push(await action(h, 'upload', uploadForm({ requirementCode: SECRET_CODE, file: file() })));
    h.fns.finalizeVerificationDocument.mockRejectedValueOnce(apiError(400, 'TRUST_SCAN_INFECTED', { file: NAME, bytes: BYTES }, `infected ${NAME}`));
    results.push(await action(h, 'upload', uploadForm({ requirementCode: SECRET_CODE, file: file() })));
    h.fns.withdrawVerificationDocument.mockRejectedValueOnce(apiError(404, 'TRUST_NOT_FOUND', { documentId: SECRET_DOC }));
    results.push(await action(h, 'withdraw', pairs(['documentId', SECRET_DOC])));
    results.push(await action(h, 'withdraw', pairs(['documentId', SECRET_DOC])));
    h.fns.submitProviderVerification.mockRejectedValueOnce(apiError(409, 'TRUST_STALE_CASE', { revision: 987654321 }));
    results.push(await action(h, 'submit', pairs(['expectedRevision', '987654321'])));
    h.fns.reverifyProviderRequirement.mockRejectedValueOnce(apiError(409, 'TRUST_NOT_REVERIFIABLE', { code: SECRET_CODE }));
    results.push(await action(h, 'reverify', pairs(['requirementCode', SECRET_CODE])));
    results.push(await action(h, 'open'), await action(h, 'cancel'));
    const markers = [
      NAME,
      'my-secret-passport',
      BYTES,
      'SECRET-EVIDENCE',
      uploadUrl(),
      UPLOAD_PATH,
      'ONE-TIME-SIGNATURE',
      '127.0.0.1',
      'X-Signature',
      'application/pdf',
      SECRET_CODE,
      SECRET_DOC,
      '987654321',
      TOKENS.access,
      TOKENS.refresh,
      TOKENS.id,
      'sid-1',
      'user-1',
    ];
    expect(results).toHaveLength(11);
    for (const res of results) {
      const text = await seen(res);
      for (const marker of markers) expect(text, marker).not.toContain(marker);
    }
    const logs = h.logs.join('\n');
    expect(h.logs.length).toBeGreaterThan(3);
    for (const marker of markers) expect(logs, marker).not.toContain(marker);
  });
  it('every log line has only the level, a fixed message and the keys action, code and status', async () => {
    const h = newHarness();
    seed(h);
    h.fns.requestVerificationUpload.mockRejectedValueOnce(apiError(400, 'TRUST_FILE_TOO_LARGE'));
    await action(h, 'upload');
    target.script.push({ status: 500 });
    await action(h, 'upload');
    target.script.push('destroy');
    await action(h, 'upload');
    for (const line of logged(h)) {
      expect(
        Object.keys(line).every((k) => ['level', 'message', 'action', 'code', 'status'].includes(k)),
        JSON.stringify(line),
      ).toBe(true);
      expect(line.action).toBe('upload');
    }
    expect(logged(h)).toHaveLength(3);
  });
  it('the redirect target is fixed: it never depends on the request host, a header or a field', async () => {
    const h = newHarness();
    seed(h);
    const req = new Request('http://evil.example/auth/provider/verification/withdraw?returnTo=http://evil.example&next=//evil.example', {
      method: 'POST',
      headers: { origin: PUBLIC, cookie: SESSION_COOKIE, host: 'evil.example', 'x-forwarded-host': 'evil.example', referer: 'http://evil.example/x' },
      body: pairs(['documentId', DOC_ID]),
    });
    expectBack(await handleVerificationAction(req, h.deps, 'withdraw'), '?notice=withdrawn');
  });
  it('every 303 target of every outcome is below the web public URL /provider/verification', async () => {
    const h = newHarness();
    seed(h);
    const locations: string[] = [];
    for (const name of VERIFICATION_ACTIONS) {
      locations.push((await action(h, name)).headers.get('location')!);
      h.fns[FIRST[name]].mockRejectedValueOnce(apiError(409, 'TRUST_CONFLICT'));
      locations.push((await action(h, name)).headers.get('location')!);
    }
    expect(locations).toHaveLength(12);
    for (const l of locations) expect(l.startsWith(`${PUBLIC}/provider/verification?`), l).toBe(true);
  });
});

describe('the Next route module for /auth/provider/verification/<action>', () => {
  it('delegates each known action to the handler with the process-wide deps', async () => {
    const h = newHarness();
    seed(h);
    routeState.deps = h.deps;
    routeState.calls = 0;
    const expected: Record<VerificationAction, string> = {
      open: '?notice=opened',
      upload: '?notice=uploaded',
      withdraw: '?notice=withdrawn',
      submit: '?notice=submitted',
      cancel: '?notice=cancelled',
      reverify: '?notice=reverified',
    };
    for (const name of VERIFICATION_ACTIONS) {
      const res = await verificationPost(await build(`/auth/provider/verification/${name}`, BODIES[name]()), { params: Promise.resolve({ action: name }) });
      expect(res.headers.get('location'), name).toBe(`${PUBLIC}/provider/verification${expected[name]}`);
    }
    expect(routeState.calls).toBe(6);
  });
  it('answers an unknown action with 404 without touching the deps or the API, and GET with 405', async () => {
    const h = newHarness();
    seed(h);
    routeState.deps = h.deps;
    routeState.calls = 0;
    for (const bad of ['', 'nope', 'OPEN', 'approve', 'download', 'external', 'constructor', '__proto__', 'open/x']) {
      const res = await verificationPost(await build('/auth/provider/verification/x', pairs()), { params: Promise.resolve({ action: bad }) });
      expect(res.status, bad).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    const get = verificationGet();
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(get.headers.get('cache-control')).toBe('no-store');
    expect(routeState.calls).toBe(0);
    noApiCalls(h);
  });
});
