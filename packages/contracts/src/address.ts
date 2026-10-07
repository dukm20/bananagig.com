// Public contracts of the address model (docs/engineering/ADDRESSES.md): the country-driven address format read model, administrative areas, the
// stateless validate and format operations, the management requests for formats and areas, and the event payloads. One canonical structured address
// for every domain; no field, column or rule here is specific to one country.
import { z } from 'zod';
import { Locale } from './content';
import { envelope } from './envelope';
import { CountryCode } from './geography';
import { adminText } from './text';

// ---------------------------------------------------------------- vocabularies
/** The fields a country format may use, in no particular order (the format decides order, requirement and labels). */
export const ADDRESS_FIELD_TYPES = [
  'ORGANIZATION',
  'ADDRESS_LINE_1',
  'ADDRESS_LINE_2',
  'DEPENDENT_LOCALITY',
  'LOCALITY',
  'ADMINISTRATIVE_AREA',
  'POSTAL_CODE',
  'SORTING_CODE',
] as const;
export const AddressFieldType = z.enum(ADDRESS_FIELD_TYPES);
export type AddressFieldType = z.infer<typeof AddressFieldType>;

/** The property of the canonical address input that carries each field type. One mapping for the server validator, the formatter and every client. */
export const ADDRESS_FIELD_PROPERTIES = {
  ORGANIZATION: 'organization',
  ADDRESS_LINE_1: 'addressLine1',
  ADDRESS_LINE_2: 'addressLine2',
  DEPENDENT_LOCALITY: 'dependentLocality',
  LOCALITY: 'locality',
  ADMINISTRATIVE_AREA: 'administrativeArea',
  POSTAL_CODE: 'postalCode',
  SORTING_CODE: 'sortingCode',
} as const satisfies Record<AddressFieldType, string>;
export type AddressInputProperty = (typeof ADDRESS_FIELD_PROPERTIES)[AddressFieldType];

export const ADDRESS_INPUT_TYPES = ['TEXT', 'LOOKUP'] as const;
export const AddressInputType = z.enum(ADDRESS_INPUT_TYPES);
export type AddressInputType = z.infer<typeof AddressInputType>;
export const ADDRESS_NORMALIZATION_RULES = ['UPPERCASE', 'REMOVE_SPACES', 'UPPERCASE_REMOVE_SPACES'] as const;
export const AddressNormalizationRule = z.enum(ADDRESS_NORMALIZATION_RULES);
export type AddressNormalizationRule = z.infer<typeof AddressNormalizationRule>;
/** How the ADMINISTRATIVE_AREA field is entered: pick a canonical area, type free text, or the country format has no such field. */
export const ADMINISTRATIVE_AREA_MODES = ['LOOKUP', 'FREE_TEXT', 'NONE'] as const;
export const AdministrativeAreaMode = z.enum(ADMINISTRATIVE_AREA_MODES);
export type AdministrativeAreaMode = z.infer<typeof AdministrativeAreaMode>;
export const ADMINISTRATIVE_AREA_TYPES = ['STATE', 'PROVINCE', 'TERRITORY', 'DISTRICT', 'REGION', 'COUNTY', 'OTHER'] as const;
export const AdministrativeAreaType = z.enum(ADMINISTRATIVE_AREA_TYPES);
export type AdministrativeAreaType = z.infer<typeof AdministrativeAreaType>;
export const ADDRESS_FORMAT_STATUSES = ['DRAFT', 'PUBLISHED'] as const;
export const AddressFormatStatus = z.enum(ADDRESS_FORMAT_STATUSES);
export type AddressFormatStatus = z.infer<typeof AddressFormatStatus>;
export const ADDRESS_VALIDATION_STATUSES = ['UNVERIFIED', 'FORMAT_VALID', 'GEOCODED', 'VERIFIED', 'INVALID'] as const;
export const AddressValidationStatus = z.enum(ADDRESS_VALIDATION_STATUSES);
export type AddressValidationStatus = z.infer<typeof AddressValidationStatus>;
export const ADDRESS_VALIDATION_SOURCES = ['MANUAL', 'AUTOCOMPLETE', 'GEOCODER', 'ADMIN', 'IMPORTED'] as const;
export const AddressValidationSource = z.enum(ADDRESS_VALIDATION_SOURCES);
export type AddressValidationSource = z.infer<typeof AddressValidationSource>;

/** Why a field was rejected. The code never carries the rejected value. */
export const ADDRESS_ISSUE_CODES = [
  'REQUIRED',
  'TOO_LONG',
  'INVALID_FORMAT',
  'UNKNOWN_AREA',
  'UNSUPPORTED_FIELD',
  'INVALID_CHARACTERS',
  'LOOKUP_UNAVAILABLE',
] as const;
export const AddressIssueCode = z.enum(ADDRESS_ISSUE_CODES);
export type AddressIssueCode = z.infer<typeof AddressIssueCode>;
/**
 * The content key of the message for an issue code. Form and server use the same key, so a field rejected by the form and by the server shows the
 * same managed text (SV-10.11); the web resolves it through the content API.
 */
export const addressIssueMessageKey = (code: AddressIssueCode): string => `address.error.${code.toLowerCase()}`;

// ---------------------------------------------------------------- the canonical address input and its normalized form
/** Generous transport ceiling; the country format applies the real per-field limit. */
const value = z.string().max(500);
export const AddressInput = z
  .object({
    countryCode: CountryCode,
    organization: value.optional(),
    addressLine1: value.optional(),
    addressLine2: value.optional(),
    dependentLocality: value.optional(),
    locality: value.optional(),
    /** A canonical area code or name when the format uses a lookup, free text otherwise. */
    administrativeArea: value.optional(),
    postalCode: value.optional(),
    sortingCode: value.optional(),
  })
  .strict();
export type AddressInput = z.infer<typeof AddressInput>;

/** The normalized structured address (what is stored). Absent parts are null. */
export const NormalizedAddressDto = z.object({
  countryCode: z.string(),
  organization: z.string().nullable(),
  addressLine1: z.string(),
  addressLine2: z.string().nullable(),
  dependentLocality: z.string().nullable(),
  locality: z.string().nullable(),
  /** Canonical code of the area when the format uses a lookup (the area name is in administrativeAreaName), null for free text. */
  administrativeAreaCode: z.string().nullable(),
  administrativeAreaName: z.string().nullable(),
  postalCode: z.string().nullable(),
  sortingCode: z.string().nullable(),
});
export type NormalizedAddressDto = z.infer<typeof NormalizedAddressDto>;

export const AddressIssueDto = z.object({
  /** The input property that failed, or `countryCode`. */
  field: z.string(),
  code: AddressIssueCode,
  /** Content key of the message (address.error.<code>), resolved by the client with the content API. */
  messageKey: z.string(),
});
export type AddressIssueDto = z.infer<typeof AddressIssueDto>;

export const AddressValidationResultDto = z.object({
  valid: z.boolean(),
  /** Present when valid. */
  address: NormalizedAddressDto.nullable(),
  issues: z.array(AddressIssueDto),
  /** The version of the country format the address was checked against. */
  formatVersion: z.number().int(),
});
export type AddressValidationResultDto = z.infer<typeof AddressValidationResultDto>;

export const FormattedAddressDto = z.object({
  /** Display lines, country line last when requested. */
  lines: z.array(z.string()),
  /** The lines joined with a newline. */
  text: z.string(),
  /** The lines joined with a comma, for one-line displays. */
  singleLine: z.string(),
  formatVersion: z.number().int(),
});
export type FormattedAddressDto = z.infer<typeof FormattedAddressDto>;

// ---------------------------------------------------------------- read models
export const AddressFormatFieldDto = z.object({
  fieldType: AddressFieldType,
  /** The property of the address input that carries this field. */
  property: z.string(),
  displayOrder: z.number().int(),
  /** Content key of the label; resolve it with the content API using the country as context. */
  contentLabelKey: z.string(),
  required: z.boolean(),
  maxLength: z.number().int(),
  inputType: AddressInputType,
  /** Regular expression the normalized value must fully match, null when none. The server applies exactly this one. */
  validationPattern: z.string().nullable(),
  example: z.string().nullable(),
  /** HTML autocomplete token. */
  autocomplete: z.string().nullable(),
  normalization: AddressNormalizationRule.nullable(),
});
export type AddressFormatFieldDto = z.infer<typeof AddressFormatFieldDto>;

export const AddressFormatDto = z.object({
  countryCode: z.string(),
  version: z.number().int(),
  fields: z.array(AddressFormatFieldDto),
  administrativeAreaMode: AdministrativeAreaMode,
  /** Example of the postal code, null when the country has no postal code or none was configured. */
  postalCodeExample: z.string().nullable(),
  /** management only */
  status: AddressFormatStatus.optional(),
  displayTemplate: z.string().optional(),
  effectiveFrom: z.string().optional(),
  effectiveTo: z.string().nullable().optional(),
});
export type AddressFormatDto = z.infer<typeof AddressFormatDto>;

export const AdministrativeAreaDto = z.object({
  code: z.string(),
  name: z.string(),
  type: AdministrativeAreaType,
  parentCode: z.string().nullable(),
  displayOrder: z.number().int().nullable(),
  /** management only */
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});
export type AdministrativeAreaDto = z.infer<typeof AdministrativeAreaDto>;

export const AdministrativeAreaListDto = z.object({
  countryCode: z.string(),
  mode: AdministrativeAreaMode,
  areas: z.array(AdministrativeAreaDto),
});
export type AdministrativeAreaListDto = z.infer<typeof AdministrativeAreaListDto>;

// ---------------------------------------------------------------- requests
export const ValidateAddressRequest = z.object({ address: AddressInput }).strict();
export type ValidateAddressRequest = z.infer<typeof ValidateAddressRequest>;
export const FormatAddressRequest = z
  .object({
    address: AddressInput,
    /** Locale of the country line (default: the country's default locale). */
    locale: Locale.optional(),
    /** Append the country name (for an address shown outside its own country). Default false. */
    includeCountry: z.boolean().optional(),
  })
  .strict();
export type FormatAddressRequest = z.infer<typeof FormatAddressRequest>;

const contentKey = z
  .string()
  .max(160)
  .regex(/^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$/);
const reason = adminText(1000);
/** Field definition in a draft. The ARRAY ORDER is the display order. */
export const AddressFormatFieldInput = z
  .object({
    fieldType: AddressFieldType,
    contentLabelKey: contentKey,
    required: z.boolean(),
    maxLength: z.number().int().min(1).max(200),
    inputType: AddressInputType.default('TEXT'),
    validationPattern: z.string().min(1).max(200).nullish(),
    example: adminText(100).nullish(),
    autocomplete: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,39}$/)
      .nullish(),
    normalization: AddressNormalizationRule.nullish(),
  })
  .strict();
export type AddressFormatFieldInput = z.infer<typeof AddressFormatFieldInput>;
export const CreateAddressFormatRequest = z
  .object({
    /** Lines separated by a newline; every field of the format must appear once as {FIELD_TYPE}. */
    displayTemplate: z.string().min(1).max(500),
    fields: z.array(AddressFormatFieldInput).min(1).max(ADDRESS_FIELD_TYPES.length),
    /** Proposed start; raised to the publication instant when later publication happens after it. */
    effectiveFrom: z.string().datetime({ offset: true }).optional(),
    reason,
  })
  .strict();
export type CreateAddressFormatRequest = z.infer<typeof CreateAddressFormatRequest>;
export const PublishAddressFormatRequest = z.object({ effectiveFrom: z.string().datetime({ offset: true }).optional(), reason }).strict();
export type PublishAddressFormatRequest = z.infer<typeof PublishAddressFormatRequest>;

export const AdministrativeAreaInput = z
  .object({
    code: z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,9}$/),
    name: adminText(120),
    type: AdministrativeAreaType,
    /** Code of an existing area of the same country. Only settable when the area is created. */
    parentCode: z
      .string()
      .regex(/^[A-Z0-9][A-Z0-9-]{0,9}$/)
      .nullish(),
    displayOrder: z.number().int().min(0).max(100000).nullish(),
    /** Default true for a new area; false retires it (rows are never deleted). */
    active: z.boolean().optional(),
  })
  .strict();
export type AdministrativeAreaInput = z.infer<typeof AdministrativeAreaInput>;
/** Creates the areas that do not exist yet and updates name, type, display order and activity of the ones that do. */
export const UpsertAdministrativeAreasRequest = z.object({ areas: z.array(AdministrativeAreaInput).min(1).max(500), reason }).strict();
export type UpsertAdministrativeAreasRequest = z.infer<typeof UpsertAdministrativeAreasRequest>;
export const UpsertAdministrativeAreasResultDto = z.object({ countryCode: z.string(), added: z.number().int(), updated: z.number().int() });
export type UpsertAdministrativeAreasResultDto = z.infer<typeof UpsertAdministrativeAreasResultDto>;

// ---------------------------------------------------------------- responses
export const AddressFormatResponse = envelope(AddressFormatDto);
export const AddressFormatListResponse = envelope(z.array(AddressFormatDto));
export const AdministrativeAreaListResponse = envelope(AdministrativeAreaListDto);
export const AddressValidationResponse = envelope(AddressValidationResultDto);
export const FormatAddressResponse = envelope(z.object({ address: NormalizedAddressDto, formatted: FormattedAddressDto }));
export const UpsertAdministrativeAreasResponse = envelope(UpsertAdministrativeAreasResultDto);

// ---------------------------------------------------------------- events (transactional outbox; identifiers and counts only, never address data)
export const AddressFormatPublishedPayload = z.object({ countryCode: z.string(), version: z.number().int(), effectiveFrom: z.string() });
export type AddressFormatPublishedPayload = z.infer<typeof AddressFormatPublishedPayload>;
export const AdministrativeAreasUpdatedPayload = z.object({ countryCode: z.string(), added: z.number().int(), updated: z.number().int() });
export type AdministrativeAreasUpdatedPayload = z.infer<typeof AdministrativeAreasUpdatedPayload>;
