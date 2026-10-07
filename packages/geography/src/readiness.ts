// The extensible market readiness registry. Readiness is DERIVED, never stored: every registered check is evaluated against the
// market's current dependencies each time. Activation runs every registered check and is refused when a required one fails.
// Future checkpoints register their own checks through registerReadinessCheck (TAX, PAYMENT_PROVIDER, ADDRESS_FORMAT, AUTOCOMPLETE,
// CONTENT_TRANSLATION); none of them exists yet and none is implemented here.
import type { GeoStatus, MarketReadinessDto } from '@bananagig/contracts';
import { log } from '@bananagig/observability';

/** The facts about a market and its dependencies that the built-in checks need (loaded under share locks during activation). */
export interface ReadinessContext {
  market: { code: string; status: GeoStatus; countryCode: string; defaultLocale: string; currencyCode: string; defaultTimeZone: string };
  country: { code: string; status: GeoStatus };
  currency: { code: string; status: GeoStatus };
  locale: { tag: string; isActive: boolean };
  timeZone: { ianaName: string; status: GeoStatus };
  /** Evaluation time. */
  at: Date;
}
export interface ReadinessCheckOutcome {
  passed: boolean;
  /** Human-readable, free of secrets and personal data. */
  detail: string;
}
export interface ReadinessCheck {
  /** UPPER_SNAKE identifier, unique in a registry. */
  code: string;
  description: string;
  /** Default true. A failing non-required check is reported but does not block activation. */
  required?: boolean;
  /** May be async and may read other tables (inside the activation transaction, through `database.db`); keep it fast. */
  evaluate(ctx: ReadinessContext): ReadinessCheckOutcome | Promise<ReadinessCheckOutcome>;
}
export interface ReadinessCheckResult {
  code: string;
  passed: boolean;
  detail: string;
  required: boolean;
}
export interface ReadinessReport {
  ready: boolean;
  checks: ReadinessCheckResult[];
}

export const BUILT_IN_READINESS_CODES = ['COUNTRY_ACTIVE', 'CURRENCY_ACTIVE', 'LOCALE_ACTIVE', 'TIME_ZONE_ACTIVE'] as const;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

const builtIns: ReadinessCheck[] = [
  {
    code: 'COUNTRY_ACTIVE',
    description: 'The market country is ACTIVE',
    evaluate: (c) => ({ passed: c.country.status === 'ACTIVE', detail: `country ${c.country.code} is ${c.country.status}` }),
  },
  {
    code: 'CURRENCY_ACTIVE',
    description: 'The market currency is ACTIVE',
    evaluate: (c) => ({ passed: c.currency.status === 'ACTIVE', detail: `currency ${c.currency.code} is ${c.currency.status}` }),
  },
  {
    code: 'LOCALE_ACTIVE',
    description: 'The market default locale is an ACTIVE locale',
    evaluate: (c) => ({ passed: c.locale.isActive, detail: `locale ${c.locale.tag} is ${c.locale.isActive ? 'ACTIVE' : 'not active'}` }),
  },
  {
    code: 'TIME_ZONE_ACTIVE',
    description: 'The market default time zone is ACTIVE',
    evaluate: (c) => ({ passed: c.timeZone.status === 'ACTIVE', detail: `time zone ${c.timeZone.ianaName} is ${c.timeZone.status}` }),
  },
];

export class ReadinessRegistry {
  private readonly checks = new Map<string, ReadinessCheck>();

  constructor(withBuiltIns = true) {
    if (withBuiltIns) for (const c of builtIns) this.checks.set(c.code, c);
  }

  /** Registers a check; returns a function that removes it again. A duplicate code is a programming error. */
  register(check: ReadinessCheck): () => void {
    if (!CODE.test(check.code)) throw new Error(`invalid readiness check code: ${check.code}`);
    if (this.checks.has(check.code)) throw new Error(`readiness check already registered: ${check.code}`);
    this.checks.set(check.code, check);
    return () => {
      this.checks.delete(check.code);
    };
  }
  list(): ReadinessCheck[] {
    return [...this.checks.values()];
  }
  has(code: string): boolean {
    return this.checks.has(code);
  }

  /**
   * Runs every registered check. A check that throws is reported as failed with a fixed detail (its error text is logged, never returned),
   * so a faulty check can block activation but never leak internals or crash a read.
   */
  async evaluate(ctx: ReadinessContext): Promise<ReadinessReport> {
    const checks: ReadinessCheckResult[] = [];
    for (const check of this.checks.values()) {
      const required = check.required !== false;
      try {
        const r = await check.evaluate(ctx);
        checks.push({ code: check.code, passed: r.passed === true, detail: String(r.detail), required });
      } catch (err) {
        log('warn', 'geography readiness check failed to evaluate', {
          check: check.code,
          market: ctx.market.code,
          error: err instanceof Error ? err.message : String(err),
        });
        checks.push({ code: check.code, passed: false, detail: 'the check could not be evaluated', required });
      }
    }
    return { ready: checks.every((c) => c.passed || !c.required), checks };
  }
}

/** The process-wide registry (the four built-ins). Future checkpoints add their checks here at start-up. */
export const defaultReadinessRegistry = new ReadinessRegistry();
export const registerReadinessCheck = (check: ReadinessCheck): (() => void) => defaultReadinessRegistry.register(check);

/** The wire shape (management API): no `required` flag per check. */
export const toReadinessDto = (market: string, report: ReadinessReport): MarketReadinessDto => ({
  market,
  ready: report.ready,
  checks: report.checks.map(({ code, passed, detail }) => ({ code, passed, detail })),
});
