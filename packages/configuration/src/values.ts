// Typed value validation. Parameter definitions control validation; the server never trusts the caller.
// Canonical JSON encodings: STRING string; INTEGER safe integer; DECIMAL canonical decimal STRING (never a float);
// BOOLEAN boolean; ENUM string; DURATION {amount, unit}; MONEY {amount_minor, currency}; JSON any JSON value.
import { Ajv } from 'ajv';
import { DurationValue, MoneyValue, ValidationRules, type DataType, type Sensitivity } from '@bananagig/contracts';
import { ConfigurationError } from './errors';

const fail = (message: string, details: Record<string, unknown> = {}): never => {
  throw new ConfigurationError('VALIDATION_FAILED', message, details);
};
const DECIMAL = /^-?(0|[1-9]\d*)(\.\d{1,18})?$/;
const UNIT_SECONDS = { SECONDS: 1, MINUTES: 60, HOURS: 3600, DAYS: 86400 } as const;

const toScaled = (d: string): bigint => {
  const neg = d.startsWith('-');
  const [i, f = ''] = d.replace('-', '').split('.');
  const v = BigInt(i! + f.padEnd(18, '0'));
  return neg ? -v : v;
};
/** Exact decimal comparison without floating point. */
export const compareDecimal = (a: string, b: string): number => (toScaled(a) < toScaled(b) ? -1 : toScaled(a) > toScaled(b) ? 1 : 0);
export const durationSeconds = (d: { amount: number; unit: keyof typeof UNIT_SECONDS }): number => d.amount * UNIT_SECONDS[d.unit];

const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
const schemaValidator = (schema: Record<string, unknown>) => {
  const k = JSON.stringify(schema);
  let v = compiled.get(k);
  if (!v) compiled.set(k, (v = ajv.compile(schema)));
  return v;
};

export interface DefinitionLike {
  dataType: DataType;
  validationRules: Record<string, unknown>;
}

/** Validates a candidate value against the definition and returns its canonical form. */
export function validateValue(def: DefinitionLike, raw: unknown): unknown {
  const rules = ValidationRules.parse(def.validationRules);
  switch (def.dataType) {
    case 'STRING': {
      if (typeof raw !== 'string') return fail('value must be a string');
      if (rules.minLength !== undefined && raw.length < rules.minLength) fail(`value is shorter than ${rules.minLength}`);
      if (rules.maxLength !== undefined && raw.length > rules.maxLength) fail(`value is longer than ${rules.maxLength}`);
      if (rules.pattern && !new RegExp(rules.pattern).test(raw)) fail('value does not match the required pattern');
      return raw;
    }
    case 'INTEGER': {
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) return fail('value must be a safe integer');
      if (typeof rules.min === 'number' && raw < rules.min) fail(`value is below the minimum ${rules.min}`);
      if (typeof rules.max === 'number' && raw > rules.max) fail(`value is above the maximum ${rules.max}`);
      return raw;
    }
    case 'DECIMAL': {
      if (typeof raw !== 'string' || !DECIMAL.test(raw))
        return fail('value must be a decimal string such as "12.50" (floating point numbers are not accepted)');
      if (typeof rules.min === 'string' && compareDecimal(raw, rules.min) < 0) fail(`value is below the minimum ${rules.min}`);
      if (typeof rules.max === 'string' && compareDecimal(raw, rules.max) > 0) fail(`value is above the maximum ${rules.max}`);
      return raw;
    }
    case 'BOOLEAN':
      return typeof raw === 'boolean' ? raw : fail('value must be a boolean');
    case 'ENUM': {
      if (typeof raw !== 'string' || !rules.enum?.includes(raw)) return fail('value is not one of the allowed options');
      return raw;
    }
    case 'DURATION': {
      const p = DurationValue.safeParse(raw);
      if (!p.success) return fail('value must be {"amount": <non-negative integer>, "unit": SECONDS|MINUTES|HOURS|DAYS}');
      const secs = durationSeconds(p.data);
      const bound = (b: unknown): number | undefined => {
        const x = DurationValue.safeParse(b);
        return x.success ? durationSeconds(x.data) : undefined;
      };
      const min = bound(rules.min);
      const max = bound(rules.max);
      if (min !== undefined && secs < min) fail('duration is below the minimum');
      if (max !== undefined && secs > max) fail('duration is above the maximum');
      return p.data;
    }
    case 'MONEY': {
      const p = MoneyValue.safeParse(raw);
      if (!p.success || !Number.isSafeInteger(p.data.amount_minor))
        return fail('value must be {"amount_minor": <integer minor units>, "currency": <ISO-4217 code>}');
      if (rules.currencies && !rules.currencies.includes(p.data.currency)) fail('currency is not allowed for this parameter');
      if (typeof rules.min === 'number' && p.data.amount_minor < rules.min) fail('amount is below the minimum');
      if (typeof rules.max === 'number' && p.data.amount_minor > rules.max) fail('amount is above the maximum');
      return p.data;
    }
    case 'JSON': {
      if (raw === undefined) return fail('a JSON value is required');
      if (rules.schema && !schemaValidator(rules.schema)(raw)) fail('value does not satisfy the JSON schema');
      return raw;
    }
  }
}

/** Checks that validation rules are coherent for the data type (called when a definition is created). */
export function validateDefinitionRules(dataType: DataType, rulesRaw: unknown): Record<string, unknown> {
  const parsed = ValidationRules.safeParse(rulesRaw ?? {});
  if (!parsed.success) return fail('validationRules are malformed');
  const rules = parsed.data;
  const only = (keys: (keyof typeof rules)[], types: DataType[]) => {
    for (const k of keys) if (rules[k] !== undefined && !types.includes(dataType)) fail(`rule "${k}" does not apply to ${dataType}`);
  };
  only(['minLength', 'maxLength', 'pattern'], ['STRING']);
  only(['enum'], ['ENUM']);
  only(['currencies'], ['MONEY']);
  only(['schema'], ['JSON']);
  only(['min', 'max'], ['INTEGER', 'DECIMAL', 'DURATION', 'MONEY']);
  if (dataType === 'ENUM' && !rules.enum) fail('ENUM parameters require validationRules.enum');
  if (rules.pattern) {
    try {
      new RegExp(rules.pattern);
    } catch {
      fail('validationRules.pattern is not a valid regular expression');
    }
  }
  if (rules.schema) {
    try {
      ajv.compile(rules.schema);
    } catch {
      fail('validationRules.schema is not a valid JSON schema');
    }
  }
  // min/max must themselves be valid canonical values of the type
  for (const k of ['min', 'max'] as const) {
    if (rules[k] === undefined) continue;
    if (dataType === 'INTEGER' || dataType === 'MONEY') {
      if (typeof rules[k] !== 'number' || !Number.isSafeInteger(rules[k])) fail(`validationRules.${k} must be a safe integer`);
    } else if (dataType === 'DECIMAL') {
      if (typeof rules[k] !== 'string' || !DECIMAL.test(rules[k] as string)) fail(`validationRules.${k} must be a decimal string`);
    } else if (dataType === 'DURATION' && !DurationValue.safeParse(rules[k]).success) fail(`validationRules.${k} must be a duration`);
  }
  return rules as Record<string, unknown>;
}

/** Sensitive values never leave the service through ordinary read paths. */
export function redactValue(sensitivity: Sensitivity, value: unknown): { value: unknown | null; redacted: boolean } {
  return sensitivity === 'SENSITIVE' ? { value: null, redacted: true } : { value, redacted: false };
}
