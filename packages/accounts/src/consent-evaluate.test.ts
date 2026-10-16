// Unit tests of the pure consent evaluation (ID-005): every status x mode x locale x role case, table driven. No database, no network.
import {
  CONSENT_REQUIREMENT_STATUSES,
  REACCEPTANCE_MODES,
  isOutstandingStatus,
  type ConsentRequirementStatus,
  type ReacceptanceMode,
} from '@bananagig/contracts';
import { describe, expect, it } from 'vitest';
import {
  acceptanceStateOf,
  evaluateRequirement,
  isRequiredFor,
  summarizeRequirements,
  type EvaluationDocument,
  type EvaluationEvent,
} from './consent-evaluate';

const DOC: EvaluationDocument = { versionId: 'v2-en', locale: 'en-US' };
const accepted = (versionId: string, locale = 'en-US'): EvaluationEvent => ({ eventType: 'ACCEPTED', versionId, locale });
const withdrawn = (versionId: string, locale = 'en-US'): EvaluationEvent => ({ eventType: 'WITHDRAWN', versionId, locale });

describe('isRequiredFor', () => {
  it.each([
    [['CUSTOMER', 'PROVIDER'], ['CUSTOMER'], true],
    [['CUSTOMER', 'PROVIDER'], ['PROVIDER'], true],
    [['CUSTOMER', 'PROVIDER'], ['CUSTOMER', 'PROVIDER'], true],
    [['PROVIDER'], ['CUSTOMER'], false],
    [['PROVIDER'], ['CUSTOMER', 'PROVIDER'], true],
    [[], ['CUSTOMER', 'PROVIDER'], false],
    [['CUSTOMER'], [], false],
    [[], [], false],
    [['CUSTOMER'], ['customer'], false],
  ])('required %j for roles %j -> %s', (requiredFor, roles, expected) => {
    expect(isRequiredFor(requiredFor, roles)).toBe(expected);
  });
});

describe('acceptanceStateOf', () => {
  it('derives the state from the latest event only', () => {
    expect(acceptanceStateOf(null)).toBe('NONE');
    expect(acceptanceStateOf({ eventType: 'ACCEPTED' })).toBe('ACCEPTED');
    expect(acceptanceStateOf({ eventType: 'WITHDRAWN' })).toBe('WITHDRAWN');
  });
});

const EN = 'en-US';
/** A required purpose evaluated in en-US. */
const ev = (reacceptance: ReacceptanceMode, document: EvaluationDocument | null, latest: EvaluationEvent | null, required = true) =>
  evaluateRequirement({ required, reacceptance, evaluatedLocale: EN, document, latest });

describe('evaluateRequirement', () => {
  it.each(REACCEPTANCE_MODES)('NOT_REQUIRED wins over everything (mode %s)', (mode) => {
    for (const document of [null, DOC]) {
      for (const latest of [null, accepted('v1-en'), accepted('v2-en'), withdrawn('v2-en')]) {
        expect(ev(mode, document, latest, false).status).toBe('NOT_REQUIRED');
      }
    }
  });

  it('keeps the acceptance state of a voluntary acceptance while NOT_REQUIRED', () => {
    expect(ev('REACCEPT_REQUIRED', DOC, accepted('v2-en'), false)).toEqual({ status: 'NOT_REQUIRED', acceptanceState: 'ACCEPTED' });
  });

  // [mode, latest, expected] for a required purpose with NO version in force in en-US (a Legal timeline gap, a deactivated entry or locale, or no translation yet)
  const no_document_cases: [ReacceptanceMode, EvaluationEvent | null, ConsentRequirementStatus][] = [
    ['REACCEPT_REQUIRED', null, 'DOCUMENT_UNAVAILABLE'],
    ['REACCEPT_REQUIRED', accepted('v1-en'), 'DOCUMENT_UNAVAILABLE'],
    ['REACCEPT_REQUIRED', accepted('v1-fr', 'fr-FR'), 'DOCUMENT_UNAVAILABLE'],
    ['REACCEPT_REQUIRED', withdrawn('v1-en'), 'DOCUMENT_UNAVAILABLE'],
    ['REACCEPT_FOR_NEW_USERS_ONLY', null, 'DOCUMENT_UNAVAILABLE'],
    ['REACCEPT_FOR_NEW_USERS_ONLY', withdrawn('v1-en'), 'DOCUMENT_UNAVAILABLE'],
    // already accepted in the evaluated locale: stays satisfied although no document is in force now
    ['REACCEPT_FOR_NEW_USERS_ONLY', accepted('v1-en'), 'SATISFIED'],
    // accepted in another locale: not satisfied, and nothing to accept
    ['REACCEPT_FOR_NEW_USERS_ONLY', accepted('v1-fr', 'fr-FR'), 'DOCUMENT_UNAVAILABLE'],
    ['REACCEPT_FOR_NEW_USERS_ONLY', accepted('v1-en', 'en-us'), 'DOCUMENT_UNAVAILABLE'],
    ['NO_REACCEPT', null, 'DOCUMENT_UNAVAILABLE'],
    ['NO_REACCEPT', withdrawn('v1-en'), 'DOCUMENT_UNAVAILABLE'],
    ['NO_REACCEPT', accepted('v1-en'), 'SATISFIED'],
    ['NO_REACCEPT', accepted('v1-fr', 'fr-FR'), 'SATISFIED'],
  ];
  it.each(no_document_cases)('no version in force: mode %s with latest %j is %s', (mode, latest, expected) => {
    expect(ev(mode, null, latest).status).toBe(expected);
  });

  it.each(REACCEPTANCE_MODES)('never accepted or withdrawn is OUTSTANDING when a document is in force (mode %s)', (mode) => {
    expect(ev(mode, DOC, null)).toEqual({ status: 'OUTSTANDING', acceptanceState: 'NONE' });
    expect(ev(mode, DOC, withdrawn('v2-en'))).toEqual({ status: 'OUTSTANDING', acceptanceState: 'WITHDRAWN' });
    // a withdrawal of an OLD version is the same
    expect(ev(mode, DOC, withdrawn('v1-en')).status).toBe('OUTSTANDING');
  });

  // [mode, latest accepted event, expected status] for a required purpose whose version in force is DOC (v2-en, en-US)
  const accepted_cases: [ReacceptanceMode, EvaluationEvent, ConsentRequirementStatus][] = [
    ['REACCEPT_REQUIRED', accepted('v2-en'), 'SATISFIED'],
    ['REACCEPT_REQUIRED', accepted('v1-en'), 'REACCEPTANCE_REQUIRED'],
    ['REACCEPT_REQUIRED', accepted('v9-fr', 'fr-FR'), 'REACCEPTANCE_REQUIRED'],
    ['REACCEPT_FOR_NEW_USERS_ONLY', accepted('v2-en'), 'SATISFIED'],
    ['REACCEPT_FOR_NEW_USERS_ONLY', accepted('v1-en'), 'SATISFIED'],
    ['REACCEPT_FOR_NEW_USERS_ONLY', accepted('v1-fr', 'fr-FR'), 'OUTSTANDING'],
    ['REACCEPT_FOR_NEW_USERS_ONLY', accepted('v1-en', 'en-us'), 'OUTSTANDING'],
    ['NO_REACCEPT', accepted('v2-en'), 'SATISFIED'],
    ['NO_REACCEPT', accepted('v1-en'), 'SATISFIED'],
    ['NO_REACCEPT', accepted('v1-fr', 'fr-FR'), 'SATISFIED'],
  ];
  it.each(accepted_cases)('document in force: mode %s with latest %j is %s', (mode, latest, expected) => {
    const r = ev(mode, DOC, latest);
    expect(r.status).toBe(expected);
    expect(r.acceptanceState).toBe('ACCEPTED');
  });

  it('evaluates another locale against the evaluated locale, not against a fixed one', () => {
    const fr = { versionId: 'v1-fr', locale: 'fr-FR' };
    const r = evaluateRequirement({
      required: true,
      reacceptance: 'REACCEPT_FOR_NEW_USERS_ONLY',
      evaluatedLocale: 'fr-FR',
      document: fr,
      latest: accepted('v1-fr', 'fr-FR'),
    });
    expect(r.status).toBe('SATISFIED');
    expect(
      evaluateRequirement({ required: true, reacceptance: 'REACCEPT_FOR_NEW_USERS_ONLY', evaluatedLocale: 'fr-FR', document: null, latest: accepted('v1-en') })
        .status,
    ).toBe('DOCUMENT_UNAVAILABLE');
  });

  it('reaches every requirement status', () => {
    const reached = new Set<ConsentRequirementStatus>();
    for (const mode of REACCEPTANCE_MODES)
      for (const required of [true, false])
        for (const document of [null, DOC])
          for (const latest of [null, accepted('v1-en'), accepted('v2-en'), accepted('x', 'fr-FR'), withdrawn('v2-en')])
            reached.add(ev(mode, document, latest, required).status);
    expect([...reached].sort()).toEqual([...CONSENT_REQUIREMENT_STATUSES].sort());
  });

  it('fails closed on an unknown mode', () => {
    expect(ev('BOGUS' as ReacceptanceMode, DOC, accepted('v2-en')).status).toBe('OUTSTANDING');
    expect(ev('BOGUS' as ReacceptanceMode, null, accepted('v2-en')).status).toBe('DOCUMENT_UNAVAILABLE');
  });
});

describe('summarizeRequirements', () => {
  it('is satisfied when no required purpose is outstanding', () => {
    expect(summarizeRequirements([])).toEqual({ satisfied: true, outstanding: [] });
    expect(
      summarizeRequirements([
        { purposeCode: 'A', status: 'SATISFIED' },
        { purposeCode: 'B', status: 'NOT_REQUIRED' },
      ]),
    ).toEqual({ satisfied: true, outstanding: [] });
  });
  it.each(CONSENT_REQUIREMENT_STATUSES.filter(isOutstandingStatus))('%s is outstanding', (status) => {
    expect(
      summarizeRequirements([
        { purposeCode: 'A', status: 'SATISFIED' },
        { purposeCode: 'B', status },
      ]),
    ).toEqual({ satisfied: false, outstanding: ['B'] });
  });
});
