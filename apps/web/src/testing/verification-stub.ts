// Contract-conforming stand-in for the provider verification endpoints (TRUST-001), mounted on the content stub (the real API is exercised by its own integration tests and
// `pnpm smoke`). It behaves like the API where the web app depends on it: the calls need a bearer token, a revoked session is 401 SESSION_REVOKED, and every response is
// validated against the contract before it is served. The dto factories derive every content key from the status words, so a test states a status and gets a consistent dto.
import type http from 'node:http';
import {
  CORRELATION_HEADER,
  DocumentUploadAuthorizationResponse,
  ProviderVerificationResponse,
  TRUST_CASE_STATUSES,
  TRUST_DOCUMENT_STATUSES,
  TRUST_DOCUMENT_TYPE_CODES,
  TRUST_ERROR_CODES,
  TRUST_OVERALL_STATUSES,
  TRUST_REASON_CODES,
  TRUST_REQUIREMENT_STATUSES,
  TRUST_SCAN_STATUSES,
  VerificationDocumentResponse,
  trustDocumentStatusKey,
  trustDocumentTypeNameKey,
  trustErrorKey,
  trustReasonNameKey,
  trustRequirementInstructionsKey,
  trustRequirementNameKey,
  trustRequirementStatusKey,
  trustScanStatusKey,
  trustVerificationStatusKey,
  type DocumentUploadAuthorizationDto,
  type ProviderVerificationDto,
  type TrustOverallStatus,
  type VerificationCaseDto,
  type VerificationDocumentDto,
  type VerificationRequirementDto,
} from '@bananagig/contracts';
import type { ContentStub, StubCatalog } from './content-stub';
import { REGISTRY_COPY } from './content-stub';

export const VERIFICATION_CASE_ID = '3f0d6a1e-5b2c-4e97-8a14-c7d9e2b05f63';
export const VERIFICATION_DOCUMENT_ID = '9a4e7c10-2d58-4b3f-a6e1-0c8f5d3b7a92';
export const REQUIREMENT_ID = '5d2b8f47-1c93-4a60-9e75-b3a1c4e8d026';
/** The only upload URL the stub ever hands out: a test asserts that it appears nowhere a person (or a log) could see it. */
export const UPLOAD_URL = 'https://objects.example.test/private/trust/evidence/one-time-object?X-Signature=ONE-TIME-SIGNATURE-VALUE';

const REQUIREMENT_CODES = ['identity_verification', 'background_check', 'professional_license', 'liability_insurance', 'custom_check'] as const;

export const documentDto = (over: Partial<VerificationDocumentDto> = {}): VerificationDocumentDto => {
  const d: VerificationDocumentDto = {
    verificationDocumentId: VERIFICATION_DOCUMENT_ID,
    documentTypeCode: 'drivers_license',
    documentTypeNameKey: '',
    status: 'ATTACHED',
    statusKey: '',
    scanStatus: 'CLEAN',
    scanStatusKey: '',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    round: null,
    createdAt: '2026-10-17T08:00:00.000Z',
    submittedAt: null,
    ...over,
  };
  return {
    ...d,
    documentTypeNameKey: over.documentTypeNameKey ?? trustDocumentTypeNameKey(d.documentTypeCode),
    statusKey: over.statusKey ?? trustDocumentStatusKey(d.status),
    scanStatusKey: over.scanStatusKey ?? trustScanStatusKey(d.scanStatus),
  };
};

const OPEN_FOR_EVIDENCE = ['NOT_STARTED', 'ACTION_REQUIRED', 'REJECTED'];
export const requirementDto = (over: Partial<VerificationRequirementDto> = {}): VerificationRequirementDto => {
  const r: VerificationRequirementDto = {
    caseRequirementId: REQUIREMENT_ID,
    requirementCode: 'identity_verification',
    requirementType: 'IDENTITY',
    evidenceKind: 'DOCUMENT',
    nameKey: '',
    instructionsKey: '',
    status: 'NOT_STARTED',
    statusKey: '',
    cycle: 1,
    round: 0,
    expiresAt: null,
    reasonCode: null,
    reasonKey: null,
    canAttachEvidence: false,
    canReverify: false,
    documentTypes: [
      { code: 'drivers_license', nameKey: trustDocumentTypeNameKey('drivers_license') },
      { code: 'state_id', nameKey: trustDocumentTypeNameKey('state_id') },
      { code: 'passport', nameKey: trustDocumentTypeNameKey('passport') },
    ],
    documents: [],
    ...over,
  };
  return {
    ...r,
    nameKey: over.nameKey ?? trustRequirementNameKey(r.requirementCode),
    instructionsKey: over.instructionsKey ?? trustRequirementInstructionsKey(r.requirementCode),
    statusKey: over.statusKey ?? trustRequirementStatusKey(r.status),
    canAttachEvidence: over.canAttachEvidence ?? (r.evidenceKind === 'DOCUMENT' && OPEN_FOR_EVIDENCE.includes(r.status)),
    canReverify: over.canReverify ?? r.status === 'EXPIRED',
    reasonKey: over.reasonKey !== undefined ? over.reasonKey : r.reasonCode ? trustReasonNameKey(r.reasonCode) : null,
  };
};

export const caseDto = (over: Partial<VerificationCaseDto> = {}): VerificationCaseDto => {
  const c: VerificationCaseDto = {
    verificationCaseId: VERIFICATION_CASE_ID,
    caseNumber: 7,
    status: 'OPEN',
    statusKey: '',
    revision: 3,
    openedAt: '2026-10-17T07:30:00.000Z',
    submittedAt: null,
    ...over,
  };
  return { ...c, statusKey: over.statusKey ?? trustVerificationStatusKey(c.status) };
};

/** A provider verification read model. Default: no case yet, the prerequisite met, one DOCUMENT requirement waiting for evidence (policy requires it, the case does not hold it yet). */
export const verificationDto = (
  over: {
    prerequisiteMet?: boolean;
    case?: VerificationCaseDto | null;
    requirements?: VerificationRequirementDto[];
    status?: TrustOverallStatus;
    requiredCount?: number;
  } = {},
): ProviderVerificationDto => {
  const requirements = over.requirements ?? [requirementDto({ caseRequirementId: null, canAttachEvidence: true })];
  const caseRow = over.case === undefined ? null : over.case;
  const status: TrustOverallStatus =
    over.status ?? (caseRow ? (caseRow.status === 'CANCELLED' ? 'NOT_STARTED' : caseRow.status) : requirements.length > 0 ? 'NOT_STARTED' : 'NOT_REQUIRED');
  const approved = requirements.filter((r) => r.status === 'APPROVED');
  return {
    prerequisiteMet: over.prerequisiteMet ?? true,
    case: caseRow,
    overall: {
      status,
      statusKey: trustVerificationStatusKey(status),
      verificationComplete: requirements.length > 0 && approved.length === requirements.length,
      requiredCount: over.requiredCount ?? requirements.length,
      approvedCount: approved.length,
      missing: requirements.filter((r) => r.status === 'NOT_STARTED').map((r) => r.requirementCode),
      actionRequired: requirements.filter((r) => r.status === 'ACTION_REQUIRED' || r.status === 'REJECTED').map((r) => r.requirementCode),
      expired: requirements.filter((r) => r.status === 'EXPIRED').map((r) => r.requirementCode),
    },
    requirements,
    goLive: { evaluated: false, eligible: false },
  };
};

export const uploadAuthorizationDto = (over: Partial<DocumentUploadAuthorizationDto['upload']> = {}): DocumentUploadAuthorizationDto => ({
  document: documentDto({ status: 'UPLOAD_PENDING', scanStatus: 'PENDING' }),
  upload: { method: 'PUT', url: UPLOAD_URL, headers: { 'content-type': 'application/pdf' }, expiresAt: '2026-10-17T09:00:00.000Z', ...over },
});

export interface VerificationApiCall {
  method: string;
  path: string;
  authorization: string | undefined;
  activeRole: string | undefined;
  body: unknown;
  correlationId: string | undefined;
}
export interface VerificationApiStub {
  calls: VerificationApiCall[];
  verification: ProviderVerificationDto;
  document: VerificationDocumentDto;
  authorization: DocumentUploadAuthorizationDto;
  /** POST /provider/verification answers 201 (a new case) when true, 200 (the live one resumed) when false. */
  openCreated: boolean;
  revoked: boolean;
  /** Per-route failure `METHOD /path` (without /api/v1): status, code, category. */
  forced: Record<string, { status: number; code: string; category: string }>;
  /** Sends this JSON body (as is) instead of the data of the route, to prove a contract violation is handled. */
  rawBody: Record<string, unknown>;
  reset(): void;
  verificationCalls(): VerificationApiCall[];
}

const fresh = (): Pick<VerificationApiStub, 'verification' | 'document' | 'authorization' | 'openCreated' | 'revoked' | 'forced' | 'rawBody'> => ({
  verification: verificationDto(),
  document: documentDto(),
  authorization: uploadAuthorizationDto(),
  openCreated: true,
  revoked: false,
  forced: {},
  rawBody: {},
});

export function attachVerificationApi(stub: ContentStub): VerificationApiStub {
  const api: VerificationApiStub = {
    calls: [],
    ...fresh(),
    reset() {
      api.calls.length = 0;
      Object.assign(api, fresh());
    },
    verificationCalls: () => api.calls.filter((c) => c.path.startsWith('/api/v1/provider/verification')),
  };
  stub.extra = (req: http.IncomingMessage, body: unknown, res: http.ServerResponse): boolean => {
    const path = req.url ?? '';
    if (!path.startsWith('/api/v1/provider/verification')) return false;
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
    if (!req.headers.authorization?.startsWith('Bearer ')) return fail(401, 'AUTHENTICATION_REQUIRED', 'AUTHENTICATION');
    if (api.revoked) return fail(401, 'SESSION_REVOKED', 'AUTHENTICATION');
    const view = () => ProviderVerificationResponse.shape.data.parse(api.verification);
    const doc = () => VerificationDocumentResponse.shape.data.parse(api.document);
    const authorization = () => DocumentUploadAuthorizationResponse.shape.data.parse(api.authorization);
    if (route === 'GET /provider/verification') return ok(view());
    if (route === 'POST /provider/verification') return ok(view(), api.openCreated ? 201 : 200);
    if (route === 'POST /provider/verification/submit' || route === 'POST /provider/verification/cancel') return ok(view());
    if (route === 'POST /provider/verification/documents/upload') return ok(authorization(), 201);
    if (/^POST \/provider\/verification\/documents\/[^/]+\/(finalize|withdraw)$/.test(route)) return ok(doc());
    if (/^POST \/provider\/verification\/requirements\/[^/]+\/reverify$/.test(route)) return ok(view());
    return fail(404, 'ROUTE_NOT_FOUND', 'NOT_FOUND');
  };
  return api;
}

/** Registry copy for the page, worded unlike anything that could be hardcoded in the app (so a test proves the text came from the registry). */
const page = (suffix: string): string => `trust.verification.page.${suffix}`;
export const VERIFICATION_TEXT: Record<string, string> = {
  [page('title')]: 'Registry trust title',
  [page('intro')]: 'Registry trust intro',
  [page('status_label')]: 'Registry trust standing',
  [page('requirements_heading')]: 'Registry trust checks heading',
  [page('empty_requirements')]: 'Registry trust nothing asked',
  [page('prerequisite_hint')]: 'Registry trust finish registration first',
  [page('open_action')]: 'Registry trust begin checks',
  [page('upload_heading')]: 'Registry trust add evidence heading',
  [page('document_type_label')]: 'Registry trust kind of paper',
  [page('file_label')]: 'Registry trust pick a file',
  [page('file_help')]: 'Registry trust file help',
  [page('upload_action')]: 'Registry trust send evidence',
  [page('documents_heading')]: 'Registry trust papers heading',
  [page('withdraw_action')]: 'Registry trust take back paper',
  [page('submit_action')]: 'Registry trust hand in',
  [page('cancel_action')]: 'Registry trust drop checks',
  [page('reverify_action')]: 'Registry trust renew check',
  [page('reason_label')]: 'Registry trust reviewer said',
  [page('valid_until_label')]: 'Registry trust good through',
  [page('golive_note')]: 'Registry trust not live yet',
  [page('uploaded_notice')]: 'Registry trust paper received',
  [page('withdrawn_notice')]: 'Registry trust paper removed',
  [page('submitted_notice')]: 'Registry trust checks handed in',
  [page('cancelled_notice')]: 'Registry trust checks dropped',
  ...Object.fromEntries(
    REQUIREMENT_CODES.flatMap((c) => [
      [trustRequirementNameKey(c), `Registry check ${c}`],
      [trustRequirementInstructionsKey(c), `Registry how to ${c}`],
    ]),
  ),
  ...Object.fromEntries(TRUST_DOCUMENT_TYPE_CODES.map((c) => [trustDocumentTypeNameKey(c), `Registry paper ${c}`])),
  ...Object.fromEntries(TRUST_REASON_CODES.map((c) => [trustReasonNameKey(c), `Registry because ${c.toLowerCase()}`])),
  ...Object.fromEntries(TRUST_REQUIREMENT_STATUSES.map((s) => [trustRequirementStatusKey(s), `Registry check state ${s.toLowerCase()}`])),
  ...Object.fromEntries(
    [...new Set([...TRUST_OVERALL_STATUSES, ...TRUST_CASE_STATUSES])].map((s) => [trustVerificationStatusKey(s), `Registry overall ${s.toLowerCase()}`]),
  ),
  ...Object.fromEntries(TRUST_DOCUMENT_STATUSES.map((s) => [trustDocumentStatusKey(s), `Registry paper state ${s.toLowerCase()}`])),
  ...Object.fromEntries(TRUST_SCAN_STATUSES.map((s) => [trustScanStatusKey(s), `Registry scan state ${s.toLowerCase()}`])),
  ...Object.fromEntries(TRUST_ERROR_CODES.map((c) => [trustErrorKey(c), `Registry trust error ${c.toLowerCase()}`])),
};
export const VERIFICATION_COPY: StubCatalog = {
  'en-US': { ...REGISTRY_COPY['en-US'], ...Object.fromEntries(Object.entries(VERIFICATION_TEXT).map(([k, value]) => [k, { value }])) },
};
