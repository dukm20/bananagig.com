// Contract-conforming stand-in for the provider registration endpoints (PRO-001) plus the two PUBLIC lists the page reads (geography markets, catalogue service types),
// mounted on the content stub (the real API is exercised by its own integration tests and `pnpm smoke`). It behaves like the API where the web app depends on it:
// the provider calls need a bearer token, a revoked session is 401 SESSION_REVOKED, and every response is validated against the contract before it is served.
import type http from 'node:http';
import {
  CORRELATION_HEADER,
  ONBOARDING_STEPS,
  PROVIDER_ERROR_CODES,
  ProviderRegistrationStateResponse,
  ProviderRequirementsResponse,
  providerErrorKey,
  providerRegistrationStatusKey,
  providerRoleStateKey,
  providerStepLabelKey,
  providerStepStatusKey,
  ONBOARDING_STEP_STATUSES,
  PROVIDER_REGISTRATION_STATUSES,
  PROVIDER_ROLE_STATES,
  type CatalogServiceTypeDto,
  type MarketDto,
  type OnboardingStep,
  type OnboardingStepDto,
  type OnboardingStepStatus,
  type ProviderRegistrationDto,
  type ProviderRegistrationStateDto,
  type ProviderRequirementsDto,
} from '@bananagig/contracts';
import type { ContentStub, StubCatalog } from './content-stub';
import { REGISTRY_COPY } from './content-stub';

export const PROVIDER_REGISTRATION_ID = '7c1f0e52-4a6b-4d83-9b27-5e3a8d1c6f40';

export const registrationDto = (over: Partial<ProviderRegistrationDto> = {}): ProviderRegistrationDto => ({
  providerRegistrationId: PROVIDER_REGISTRATION_ID,
  attempt: 1,
  status: 'IN_PROGRESS',
  revision: 4,
  marketCode: null,
  serviceTypeCodes: [],
  createdAt: '2026-10-16T09:30:00.000Z',
  completedAt: null,
  cancelledAt: null,
  ...over,
});
export const stateDto = (
  registration: ProviderRegistrationDto | null,
  providerRole: ProviderRegistrationStateDto['providerRole'] = 'PENDING',
): ProviderRegistrationStateDto => ({
  providerRole,
  registration,
});
export const stepDto = (step: OnboardingStep, status: OnboardingStepStatus): OnboardingStepDto => ({
  step,
  status,
  owner: 'PRO-001',
  labelKey: providerStepLabelKey(step),
  statusKey: providerStepStatusKey(status),
});
const FUTURE: OnboardingStep[] = ['VERIFICATION', 'SUBSCRIPTION', 'PROFILE', 'GIGS'];
/** The nine steps in order; `over` sets the status of the named steps, every other registration step is COMPLETE and every future one NOT_AVAILABLE. */
export const stepsDto = (over: Partial<Record<OnboardingStep, OnboardingStepStatus>> = {}): OnboardingStepDto[] =>
  ONBOARDING_STEPS.map((s) => stepDto(s, over[s] ?? (FUTURE.includes(s) ? 'NOT_AVAILABLE' : 'COMPLETE')));
export const requirementsDto = (
  registration: ProviderRegistrationDto | null,
  steps: OnboardingStepDto[],
  over: { ready?: boolean; providerRole?: ProviderRegistrationStateDto['providerRole'] } = {},
): ProviderRequirementsDto => ({
  providerRole: over.providerRole ?? 'PENDING',
  registration,
  steps,
  overall: {
    registrationComplete: registration?.status === 'COMPLETED',
    registrationReady: over.ready ?? false,
    blockedBy: [],
    goLive: { evaluated: false, eligible: false },
  },
});
export const marketDto = (code: string, name: string): MarketDto => ({
  code,
  name,
  countryCode: 'US',
  defaultLocale: 'en-US',
  supportedLocales: ['en-US'],
  currencyCode: 'USD',
  defaultTimeZone: 'America/Los_Angeles',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
});
export const serviceTypeDto = (code: string, name: string): CatalogServiceTypeDto => ({
  serviceTypeId: '2b6f1c9e-8d34-4a57-b0c1-9e7a3d5f2814',
  code,
  categoryCode: 'home_services',
  name,
  description: null,
  displayOrder: null,
});

export interface ProviderApiCall {
  method: string;
  path: string;
  authorization: string | undefined;
  activeRole: string | undefined;
  body: unknown;
  correlationId: string | undefined;
}
export interface ProviderApiStub {
  calls: ProviderApiCall[];
  state: ProviderRegistrationStateDto;
  requirements: ProviderRequirementsDto;
  markets: MarketDto[];
  serviceTypes: CatalogServiceTypeDto[];
  /** POST /provider/registration answers 201 (a new attempt) when true, 200 (the live one resumed) when false. */
  startCreated: boolean;
  revoked: boolean;
  /** Per-route failure `METHOD /path` (without /api/v1): status, code, category. */
  forced: Record<string, { status: number; code: string; category: string }>;
  /** Sends this JSON body (as is) instead of the data of the route, to prove a contract violation is handled. */
  rawBody: Record<string, unknown>;
  reset(): void;
  providerCalls(): ProviderApiCall[];
}

const fresh = (): Pick<ProviderApiStub, 'state' | 'requirements' | 'markets' | 'serviceTypes' | 'startCreated' | 'revoked' | 'forced' | 'rawBody'> => ({
  state: stateDto(null, 'NONE'),
  requirements: requirementsDto(
    null,
    stepsDto({ ACCOUNT: 'NOT_STARTED', CONTACT: 'NOT_STARTED', LEGAL: 'NOT_STARTED', MARKET: 'NOT_STARTED', SERVICES: 'NOT_STARTED' }),
    {
      providerRole: 'NONE',
    },
  ),
  markets: [marketDto('us-orange-county', 'Orange County'), marketDto('us-los-angeles', 'Los Angeles')],
  serviceTypes: [
    serviceTypeDto('house_cleaning', 'House cleaning'),
    serviceTypeDto('car_detailing', 'Car detailing'),
    serviceTypeDto('lawn_care', 'Lawn care'),
  ],
  startCreated: true,
  revoked: false,
  forced: {},
  rawBody: {},
});

export function attachProviderApi(stub: ContentStub): ProviderApiStub {
  const api: ProviderApiStub = {
    calls: [],
    ...fresh(),
    reset() {
      api.calls.length = 0;
      Object.assign(api, fresh());
    },
    providerCalls: () => api.calls.filter((c) => c.path.startsWith('/api/v1/provider/')),
  };
  stub.extra = (req: http.IncomingMessage, body: unknown, res: http.ServerResponse): boolean => {
    const path = req.url ?? '';
    const isProvider = path.startsWith('/api/v1/provider/');
    const isPublic = path.startsWith('/api/v1/geography/markets') || path.startsWith('/api/v1/catalog/service-types');
    if (!isProvider && !isPublic) return false;
    const correlationId = req.headers[CORRELATION_HEADER] as string | undefined;
    api.calls.push({
      method: req.method ?? '',
      path,
      authorization: req.headers.authorization,
      activeRole: req.headers['x-active-role'] as string | undefined,
      body,
      correlationId,
    });
    const cid = correlationId ?? 'stub-correlation';
    res.setHeader('content-type', 'application/json').setHeader(CORRELATION_HEADER, cid);
    const fail = (status: number, code: string, category: string): boolean => {
      res.statusCode = status;
      res.end(JSON.stringify({ error: { code, category, message: code, correlationId: cid } }));
      return true;
    };
    const ok = (data: unknown, status = 200): boolean => {
      res.statusCode = status;
      res.end(JSON.stringify({ data, meta: { correlationId: cid } }));
      return true;
    };
    const route = `${req.method ?? ''} ${path.slice('/api/v1'.length).split('?')[0]}`;
    const forced = api.forced[route];
    if (forced) return fail(forced.status, forced.code, forced.category);
    const raw = api.rawBody[route];
    if (raw !== undefined) return ok(raw);
    if (isProvider) {
      if (!req.headers.authorization?.startsWith('Bearer ')) return fail(401, 'AUTHENTICATION_REQUIRED', 'AUTHENTICATION');
      if (api.revoked) return fail(401, 'SESSION_REVOKED', 'AUTHENTICATION');
    }
    const state = () => ProviderRegistrationStateResponse.shape.data.parse(api.state);
    const reqs = () => ProviderRequirementsResponse.shape.data.parse(api.requirements);
    switch (route) {
      case 'GET /provider/registration':
        return ok(state());
      case 'POST /provider/registration':
        return ok(state(), api.startCreated ? 201 : 200);
      case 'PUT /provider/registration/market':
      case 'PUT /provider/registration/services':
      case 'POST /provider/registration/cancel':
        return ok(state());
      case 'GET /provider/registration/requirements':
      case 'POST /provider/registration/submit':
        return ok(reqs());
      case 'GET /geography/markets':
        return ok(api.markets);
      case 'GET /catalog/service-types':
        return ok(api.serviceTypes);
      default:
        return fail(404, 'ROUTE_NOT_FOUND', 'NOT_FOUND');
    }
  };
  return api;
}

/** Registry copy for the page, worded unlike anything that could be hardcoded in the app (so a test proves the text came from the registry). */
const page = (suffix: string): string => `provider.registration.page.${suffix}`;
export const PROVIDER_TEXT: Record<string, string> = {
  [page('title')]: 'Registry provider title',
  [page('intro')]: 'Registry provider intro',
  [page('start_action')]: 'Registry begin registration',
  [page('restart_action')]: 'Registry begin again',
  [page('progress_heading')]: 'Registry progress heading',
  [page('market_heading')]: 'Registry market heading',
  [page('market_label')]: 'Registry market legend',
  [page('market_help')]: 'Registry market help',
  [page('services_heading')]: 'Registry services heading',
  [page('services_help')]: 'Registry services help',
  [page('save_action')]: 'Registry store choice',
  [page('cancel_action')]: 'Registry abandon registration',
  [page('submit_action')]: 'Registry finish registration',
  [page('empty_markets')]: 'Registry no markets',
  [page('empty_services')]: 'Registry no services',
  [page('contact_hint')]: 'Registry contact hint',
  [page('legal_hint')]: 'Registry legal hint',
  [page('golive_note')]: 'Registry golive note',
  [page('completed_notice')]: 'Registry completed notice',
  [page('cancelled_notice')]: 'Registry cancelled notice',
  ...Object.fromEntries(ONBOARDING_STEPS.map((s) => [providerStepLabelKey(s), `Registry step ${s.toLowerCase()}`])),
  ...Object.fromEntries(ONBOARDING_STEP_STATUSES.map((s) => [providerStepStatusKey(s), `Registry state ${s.toLowerCase()}`])),
  ...Object.fromEntries(PROVIDER_REGISTRATION_STATUSES.map((s) => [providerRegistrationStatusKey(s), `Registry registration ${s.toLowerCase()}`])),
  ...Object.fromEntries(PROVIDER_ROLE_STATES.map((s) => [providerRoleStateKey(s), `Registry role ${s.toLowerCase()}`])),
  ...Object.fromEntries(PROVIDER_ERROR_CODES.map((c) => [providerErrorKey(c), `Registry provider error ${c.toLowerCase()}`])),
};
export const PROVIDER_COPY: StubCatalog = {
  'en-US': { ...REGISTRY_COPY['en-US'], ...Object.fromEntries(Object.entries(PROVIDER_TEXT).map(([k, value]) => [k, { value }])) },
};
