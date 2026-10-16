// Phone intelligence boundary (ID-003): a provider-neutral `PhoneIntelligence` port that classifies a number (mobile, landline, VoIP, virtual, high risk). No
// commercial vendor is chosen (DEBT-0060); a vendor is one class implementing the port. The market policy that BLOCKS line types lives in configuration
// (`verification.phone.blocked_line_types`), not here: this module only reports what a number is.
import type { PhoneLineType } from '@bananagig/contracts';

export interface PhoneIntelligenceResult {
  lineType: PhoneLineType;
}

/** The lookup could not answer (vendor down, timeout). The service fails CLOSED when the market blocks any line type. */
export class PhoneIntelligenceError extends Error {
  constructor(message = 'the phone lookup is unavailable') {
    super(message);
    this.name = 'PhoneIntelligenceError';
  }
}

export interface PhoneIntelligence {
  lookup(e164: string, countryCode: string): Promise<PhoneIntelligenceResult>;
}

/** The production default until a vendor is chosen: every number is UNKNOWN (which a market may choose to block, and the default policy does not). */
export class UnknownPhoneIntelligence implements PhoneIntelligence {
  async lookup(): Promise<PhoneIntelligenceResult> {
    return { lineType: 'UNKNOWN' };
  }
}

/**
 * DEV/TEST classifier: deterministic from the LAST THREE DIGITS of the number, so tests and the smoke test can pick a line type by choosing a number.
 * 901 VOIP, 902 VIRTUAL, 903 LANDLINE, 904 HIGH_RISK, 905 the lookup fails; everything else MOBILE. Never used in production (configuration refuses it).
 */
export class FakePhoneIntelligence implements PhoneIntelligence {
  async lookup(e164: string): Promise<PhoneIntelligenceResult> {
    switch (e164.slice(-3)) {
      case '901':
        return { lineType: 'VOIP' };
      case '902':
        return { lineType: 'VIRTUAL' };
      case '903':
        return { lineType: 'LANDLINE' };
      case '904':
        return { lineType: 'HIGH_RISK' };
      case '905':
        throw new PhoneIntelligenceError();
      default:
        return { lineType: 'MOBILE' };
    }
  }
}
