// Unit tests of the CAT-004 contracts (variants, add-ons and photos of a Gig draft): the structural ceilings (which mirror the CHECK constraints of migration 0021), the two policies
// the service reads fail-closed from the configuration registry, the item key shape, and the strict request bodies. Written from the boundaries up: every number pinned here is a
// number a CHECK constraint, a guard or a configuration definition repeats, so a drift in the contract is a failing test and not a silent disagreement with the database.
import { describe, expect, it } from 'vitest';
import {
  DetachGigMediaRequest,
  FinalizeGigMediaRequest,
  GIG_ALT_TEXT_CEILING,
  GIG_DELTA_MINUTES_CEILING,
  GIG_MEDIA_EDGE_CEILING,
  GIG_MEDIA_FILE_CEILING,
  GIG_MEDIA_ITEMS_CEILING,
  GIG_MEDIA_MIME_TYPES,
  GIG_MEDIA_PIXELS_CEILING,
  GIG_OPTIONS_CEILING,
  GIG_OPTION_DESCRIPTION_CEILING,
  GIG_OPTION_NAME_CEILING,
  GIG_PRICE_MINOR_CEILING,
  GigItemKey,
  GigOptionInput,
  ProviderGigMediaPolicy,
  ProviderGigOptionsPolicy,
  ReorderGigMediaRequest,
  ReplaceGigAddOnsRequest,
  ReplaceGigVariantsRequest,
  RequestGigMediaUploadRequest,
  UpdateGigMediaRequest,
} from './gig';

const ok = (r: { success: boolean }) => r.success;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('the structural ceilings mirror the database CHECK constraints of 0021', () => {
  it('pins every number', () => {
    expect(GIG_PRICE_MINOR_CEILING).toBe(1_000_000_000_000); // ck_gig_version_variants__price_delta / add_ons
    expect(GIG_DELTA_MINUTES_CEILING).toBe(100_000); // ck_..__duration_delta
    expect(GIG_OPTION_NAME_CEILING).toBe(200); // ck_..__name
    expect(GIG_OPTION_DESCRIPTION_CEILING).toBe(2000); // ck_..__description
    expect(GIG_ALT_TEXT_CEILING).toBe(500); // ck_gig_version_media__alt_text
    expect(GIG_MEDIA_FILE_CEILING).toBe(26_214_400); // ck_media_assets__size
    expect(GIG_MEDIA_EDGE_CEILING).toBe(30_000); // ck_media_assets__dimensions
    expect(GIG_MEDIA_PIXELS_CEILING).toBe(400_000_000);
    expect(GIG_OPTIONS_CEILING).toBe(100); // the seeded definitions allow at most 100 items
    expect(GIG_MEDIA_ITEMS_CEILING).toBe(200); // the seeded definition of provider.gig.media.max_items allows at most 200
    expect([...GIG_MEDIA_MIME_TYPES]).toEqual(['image/jpeg', 'image/png', 'image/webp']); // ck_media_assets__mime_type
  });
});

describe('GigItemKey', () => {
  it.each([
    ['opt_0123456789ab', true],
    ['ab', true], // 2 characters: the shortest
    ['a' + '1'.repeat(39), true], // 40 characters: the longest
    ['a', false],
    ['a' + '1'.repeat(40), false], // 41
    ['Abc', false],
    ['1ab', false],
    ['_ab', false],
    ['ab-c', false],
    ['ab c', false],
    [' ab', false],
    ['ab\n', false],
    ['xab\nab', false], // not anchored per line
    ['', false],
  ])('%j is %s', (key, valid) => {
    expect(GigItemKey.safeParse(key).success).toBe(valid);
  });
});

describe('GigOptionInput', () => {
  const base = { name: 'Wax', description: null, priceDeltaMinor: 0, durationDeltaMinutes: 0 };
  it('accepts the boundaries: zero deltas, the ceilings, a key, a null or a long description', () => {
    expect(ok(GigOptionInput.safeParse(base))).toBe(true);
    expect(
      ok(
        GigOptionInput.safeParse({
          ...base,
          key: 'opt_0123456789ab',
          priceDeltaMinor: GIG_PRICE_MINOR_CEILING,
          durationDeltaMinutes: GIG_DELTA_MINUTES_CEILING,
        }),
      ),
    ).toBe(true);
    expect(
      ok(GigOptionInput.safeParse({ ...base, name: 'x'.repeat(GIG_OPTION_NAME_CEILING * 4), description: 'y'.repeat(GIG_OPTION_DESCRIPTION_CEILING * 4) })),
    ).toBe(true);
  });
  it.each([
    ['a negative price delta', { priceDeltaMinor: -1 }],
    ['a price delta above the ceiling', { priceDeltaMinor: GIG_PRICE_MINOR_CEILING + 1 }],
    ['a fractional price delta', { priceDeltaMinor: 1.5 }],
    ['a string price delta', { priceDeltaMinor: '1' }],
    ['a negative duration delta', { durationDeltaMinutes: -1 }],
    ['a duration delta above the ceiling', { durationDeltaMinutes: GIG_DELTA_MINUTES_CEILING + 1 }],
    ['a fractional duration delta', { durationDeltaMinutes: 0.5 }],
    ['a name above 4x the ceiling', { name: 'x'.repeat(GIG_OPTION_NAME_CEILING * 4 + 1) }],
    ['a description above 4x the ceiling', { description: 'y'.repeat(GIG_OPTION_DESCRIPTION_CEILING * 4 + 1) }],
    ['an undefined description (the field is required, null means none)', { description: undefined }],
    ['a malformed key', { key: 'Nope' }],
    ['an unknown property (no currency, no absolute price, no order)', { currency: 'USD' }],
    ['a display order from the client', { displayOrder: 1 }],
  ])('refuses %s', (_what, over) => {
    expect(ok(GigOptionInput.safeParse({ ...base, ...over }))).toBe(false);
  });
});

describe('ReplaceGigVariantsRequest and ReplaceGigAddOnsRequest', () => {
  const item = (name: string, key?: string) => ({ name, description: null, priceDeltaMinor: 1, durationDeltaMinutes: 1, ...(key ? { key } : {}) });
  it('accepts an empty list (it clears) and a list at the ceiling', () => {
    expect(ok(ReplaceGigVariantsRequest.safeParse({ expectedRevision: 1, variants: [] }))).toBe(true);
    expect(ok(ReplaceGigAddOnsRequest.safeParse({ expectedRevision: 1, addOns: [] }))).toBe(true);
    const full = Array.from({ length: GIG_OPTIONS_CEILING }, (_, i) => item(`n${i}`));
    expect(ok(ReplaceGigVariantsRequest.safeParse({ expectedRevision: 1, variants: full }))).toBe(true);
    expect(ok(ReplaceGigAddOnsRequest.safeParse({ expectedRevision: 1, addOns: full }))).toBe(true);
  });
  it('refuses one item more than the ceiling', () => {
    const over = Array.from({ length: GIG_OPTIONS_CEILING + 1 }, (_, i) => item(`n${i}`));
    expect(ok(ReplaceGigVariantsRequest.safeParse({ expectedRevision: 1, variants: over }))).toBe(false);
    expect(ok(ReplaceGigAddOnsRequest.safeParse({ expectedRevision: 1, addOns: over }))).toBe(false);
  });
  it('refuses a repeated key in one list (names may repeat here: the service decides on names)', () => {
    const dup = [item('A', 'opt_aaaaaaaaaaaa'), item('B', 'opt_aaaaaaaaaaaa')];
    expect(ok(ReplaceGigVariantsRequest.safeParse({ expectedRevision: 1, variants: dup }))).toBe(false);
    expect(ok(ReplaceGigAddOnsRequest.safeParse({ expectedRevision: 1, addOns: dup }))).toBe(false);
    expect(
      ok(
        ReplaceGigVariantsRequest.safeParse({
          expectedRevision: 1,
          variants: [item('A', 'opt_aaaaaaaaaaaa'), item('B', 'opt_bbbbbbbbbbbb'), item('C'), item('D')],
        }),
      ),
    ).toBe(true);
  });
  it('is strict, needs the revision (1 to 2^31-1) and refuses the other list and extra properties', () => {
    expect(ok(ReplaceGigVariantsRequest.safeParse({ variants: [] }))).toBe(false);
    expect(ok(ReplaceGigVariantsRequest.safeParse({ expectedRevision: 0, variants: [] }))).toBe(false);
    expect(ok(ReplaceGigVariantsRequest.safeParse({ expectedRevision: 2_147_483_647, variants: [] }))).toBe(true);
    expect(ok(ReplaceGigVariantsRequest.safeParse({ expectedRevision: 2_147_483_648, variants: [] }))).toBe(false);
    expect(ok(ReplaceGigVariantsRequest.safeParse({ expectedRevision: 1.5, variants: [] }))).toBe(false);
    expect(ok(ReplaceGigVariantsRequest.safeParse({ expectedRevision: 1, variants: [], addOns: [] }))).toBe(false);
    expect(ok(ReplaceGigAddOnsRequest.safeParse({ expectedRevision: 1, variants: [] }))).toBe(false);
    expect(ok(ReplaceGigAddOnsRequest.safeParse({ expectedRevision: 1, addOns: [], accountId: uuid(1) }))).toBe(false);
  });
});

describe('the photo requests', () => {
  const sha = 'ab'.repeat(32);
  const upload = { expectedRevision: 3, fieldKey: 'photos', mimeType: 'image/png', sizeBytes: 10, altText: null };
  it('RequestGigMediaUploadRequest: the size runs from 1 byte to the file ceiling', () => {
    expect(ok(RequestGigMediaUploadRequest.safeParse(upload))).toBe(true);
    expect(ok(RequestGigMediaUploadRequest.safeParse({ ...upload, sizeBytes: GIG_MEDIA_FILE_CEILING }))).toBe(true);
    expect(ok(RequestGigMediaUploadRequest.safeParse({ ...upload, sizeBytes: GIG_MEDIA_FILE_CEILING + 1 }))).toBe(false);
    expect(ok(RequestGigMediaUploadRequest.safeParse({ ...upload, sizeBytes: 0 }))).toBe(false);
    expect(ok(RequestGigMediaUploadRequest.safeParse({ ...upload, sizeBytes: 1.5 }))).toBe(false);
    expect(ok(RequestGigMediaUploadRequest.safeParse({ ...upload, sizeBytes: '10' }))).toBe(false);
  });
  it('RequestGigMediaUploadRequest: the client never names an account, a version, an object or a status; the hash is lower-case hex of 64 characters or absent', () => {
    expect(ok(RequestGigMediaUploadRequest.safeParse({ ...upload, sha256: sha }))).toBe(true);
    for (const bad of [sha.toUpperCase(), sha.slice(1), `${sha}0`, 'g'.repeat(64), ''])
      expect(ok(RequestGigMediaUploadRequest.safeParse({ ...upload, sha256: bad })), bad).toBe(false);
    for (const extra of [{ accountId: uuid(1) }, { objectKey: 'k' }, { status: 'READY' }, { gigVersionId: uuid(2) }])
      expect(ok(RequestGigMediaUploadRequest.safeParse({ ...upload, ...extra })), JSON.stringify(extra)).toBe(false);
    expect(ok(RequestGigMediaUploadRequest.safeParse({ ...upload, mimeType: '' }))).toBe(false);
    expect(ok(RequestGigMediaUploadRequest.safeParse({ ...upload, mimeType: 'x'.repeat(101) }))).toBe(false);
    expect(ok(RequestGigMediaUploadRequest.safeParse({ ...upload, mimeType: 'x'.repeat(100) }))).toBe(true);
    expect(ok(RequestGigMediaUploadRequest.safeParse({ ...upload, altText: 'x'.repeat(GIG_ALT_TEXT_CEILING * 4) }))).toBe(true);
    expect(ok(RequestGigMediaUploadRequest.safeParse({ ...upload, altText: 'x'.repeat(GIG_ALT_TEXT_CEILING * 4 + 1) }))).toBe(false);
    expect(ok(RequestGigMediaUploadRequest.safeParse({ ...upload, altText: undefined }))).toBe(false);
  });
  it('FinalizeGigMediaRequest and DetachGigMediaRequest are strict', () => {
    expect(ok(FinalizeGigMediaRequest.safeParse({ expectedRevision: 2 }))).toBe(true);
    expect(ok(FinalizeGigMediaRequest.safeParse({ expectedRevision: 2, sha256: sha }))).toBe(true);
    expect(ok(FinalizeGigMediaRequest.safeParse({ expectedRevision: 2, sha256: 'nope' }))).toBe(false);
    expect(ok(FinalizeGigMediaRequest.safeParse({ expectedRevision: 2, force: true }))).toBe(false);
    expect(ok(FinalizeGigMediaRequest.safeParse({}))).toBe(false);
    expect(ok(DetachGigMediaRequest.safeParse({ expectedRevision: 2 }))).toBe(true);
    expect(ok(DetachGigMediaRequest.safeParse({ expectedRevision: 2, force: true }))).toBe(false);
    expect(ok(DetachGigMediaRequest.safeParse({ expectedRevision: '2' }))).toBe(false);
  });
  it('UpdateGigMediaRequest: alt text is a string up to 4x the ceiling or null (clears it), never absent', () => {
    expect(ok(UpdateGigMediaRequest.safeParse({ expectedRevision: 1, altText: null }))).toBe(true);
    expect(ok(UpdateGigMediaRequest.safeParse({ expectedRevision: 1, altText: 'x'.repeat(GIG_ALT_TEXT_CEILING * 4) }))).toBe(true);
    expect(ok(UpdateGigMediaRequest.safeParse({ expectedRevision: 1, altText: 'x'.repeat(GIG_ALT_TEXT_CEILING * 4 + 1) }))).toBe(false);
    expect(ok(UpdateGigMediaRequest.safeParse({ expectedRevision: 1 }))).toBe(false);
    expect(ok(UpdateGigMediaRequest.safeParse({ expectedRevision: 1, altText: null, mediaId: uuid(3) }))).toBe(false);
  });
  it('ReorderGigMediaRequest: ids are UUIDs, each once, at most the item ceiling; an empty list is valid', () => {
    expect(ok(ReorderGigMediaRequest.safeParse({ expectedRevision: 1, mediaIds: [] }))).toBe(true);
    expect(ok(ReorderGigMediaRequest.safeParse({ expectedRevision: 1, mediaIds: [uuid(1), uuid(2)] }))).toBe(true);
    expect(ok(ReorderGigMediaRequest.safeParse({ expectedRevision: 1, mediaIds: [uuid(1), uuid(1)] }))).toBe(false);
    expect(ok(ReorderGigMediaRequest.safeParse({ expectedRevision: 1, mediaIds: ['nope'] }))).toBe(false);
    const full = Array.from({ length: GIG_MEDIA_ITEMS_CEILING }, (_, i) => uuid(i + 1));
    expect(ok(ReorderGigMediaRequest.safeParse({ expectedRevision: 1, mediaIds: full }))).toBe(true);
    expect(ok(ReorderGigMediaRequest.safeParse({ expectedRevision: 1, mediaIds: [...full, uuid(999)] }))).toBe(false);
    expect(ok(ReorderGigMediaRequest.safeParse({ expectedRevision: 1, mediaIds: [], extra: 1 }))).toBe(false);
  });
});

describe('ProviderGigOptionsPolicy (the fail-closed read of the four option parameters)', () => {
  const valid = { variantMaxCount: 10, addOnMaxCount: 20, nameMaxLength: 80, descriptionMaxLength: 500 };
  it('accepts the seeded values and the exact boundaries of the definitions', () => {
    expect(ok(ProviderGigOptionsPolicy.safeParse(valid))).toBe(true);
    expect(ok(ProviderGigOptionsPolicy.safeParse({ variantMaxCount: 0, addOnMaxCount: 0, nameMaxLength: 1, descriptionMaxLength: 1 }))).toBe(true); // 0 switches an option kind off
    expect(
      ok(
        ProviderGigOptionsPolicy.safeParse({
          variantMaxCount: GIG_OPTIONS_CEILING,
          addOnMaxCount: GIG_OPTIONS_CEILING,
          nameMaxLength: GIG_OPTION_NAME_CEILING,
          descriptionMaxLength: GIG_OPTION_DESCRIPTION_CEILING,
        }),
      ),
    ).toBe(true);
  });
  it.each([
    ['a negative variant count', { variantMaxCount: -1 }],
    ['a variant count above the ceiling', { variantMaxCount: GIG_OPTIONS_CEILING + 1 }],
    ['an add-on count above the ceiling', { addOnMaxCount: GIG_OPTIONS_CEILING + 1 }],
    ['a name length of zero', { nameMaxLength: 0 }],
    ['a name length above the ceiling', { nameMaxLength: GIG_OPTION_NAME_CEILING + 1 }],
    ['a description length of zero', { descriptionMaxLength: 0 }],
    ['a description length above the ceiling', { descriptionMaxLength: GIG_OPTION_DESCRIPTION_CEILING + 1 }],
    ['a fractional value', { variantMaxCount: 1.5 }],
    ['a string value', { nameMaxLength: '80' }],
    ['a missing value', { nameMaxLength: undefined }],
    ['an unknown property', { extra: 1 }],
  ])('refuses %s', (_what, over) => {
    expect(ok(ProviderGigOptionsPolicy.safeParse({ ...valid, ...over }))).toBe(false);
  });
});

describe('ProviderGigMediaPolicy (the fail-closed read of the eleven media parameters)', () => {
  const valid = {
    maxFileSizeBytes: 10_485_760,
    maxItems: 50,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    uploadTtlSeconds: 900,
    requireCleanScan: true,
    minEdgePixels: 200,
    maxEdgePixels: 12_000,
    maxPixels: 50_000_000,
    downloadTtlSeconds: 60,
    orphanGraceSeconds: 86_400,
    altTextMaxLength: 200,
  };
  it('accepts the seeded values and every exact boundary of the definitions', () => {
    expect(ok(ProviderGigMediaPolicy.safeParse(valid))).toBe(true);
    expect(
      ok(
        ProviderGigMediaPolicy.safeParse({
          maxFileSizeBytes: 1,
          maxItems: 0,
          allowedMimeTypes: ['image/png'],
          uploadTtlSeconds: 30,
          requireCleanScan: false,
          minEdgePixels: 1,
          maxEdgePixels: 1,
          maxPixels: 1,
          downloadTtlSeconds: 5,
          orphanGraceSeconds: 60,
          altTextMaxLength: 1,
        }),
      ),
    ).toBe(true);
    expect(
      ok(
        ProviderGigMediaPolicy.safeParse({
          ...valid,
          maxFileSizeBytes: GIG_MEDIA_FILE_CEILING,
          maxItems: GIG_MEDIA_ITEMS_CEILING,
          uploadTtlSeconds: 3600,
          minEdgePixels: GIG_MEDIA_EDGE_CEILING,
          maxEdgePixels: GIG_MEDIA_EDGE_CEILING,
          maxPixels: GIG_MEDIA_PIXELS_CEILING,
          downloadTtlSeconds: 600,
          orphanGraceSeconds: 2_592_000,
          altTextMaxLength: GIG_ALT_TEXT_CEILING,
        }),
      ),
    ).toBe(true);
  });
  it.each([
    ['a zero file size', { maxFileSizeBytes: 0 }],
    ['a file size above the ceiling', { maxFileSizeBytes: GIG_MEDIA_FILE_CEILING + 1 }],
    ['a negative item cap', { maxItems: -1 }],
    ['an item cap above the ceiling', { maxItems: GIG_MEDIA_ITEMS_CEILING + 1 }],
    ['an empty type list', { allowedMimeTypes: [] }],
    ['a type the build cannot verify', { allowedMimeTypes: ['image/heic'] }],
    ['a repeated type', { allowedMimeTypes: ['image/png', 'image/png'] }],
    ['four types', { allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/png'] }],
    ['an upload window of 29 seconds', { uploadTtlSeconds: 29 }],
    ['an upload window of 3601 seconds', { uploadTtlSeconds: 3601 }],
    ['a scan flag that is not a boolean', { requireCleanScan: 'true' }],
    ['a missing scan flag', { requireCleanScan: undefined }],
    ['a zero minimum edge', { minEdgePixels: 0 }],
    ['a minimum edge above the ceiling', { minEdgePixels: GIG_MEDIA_EDGE_CEILING + 1, maxEdgePixels: GIG_MEDIA_EDGE_CEILING }],
    ['a maximum edge above the ceiling', { maxEdgePixels: GIG_MEDIA_EDGE_CEILING + 1 }],
    ['a minimum edge above the maximum edge', { minEdgePixels: 13_000 }],
    ['a zero pixel cap', { maxPixels: 0 }],
    ['a pixel cap above the ceiling', { maxPixels: GIG_MEDIA_PIXELS_CEILING + 1 }],
    ['a preview window of 4 seconds', { downloadTtlSeconds: 4 }],
    ['a preview window of 601 seconds', { downloadTtlSeconds: 601 }],
    ['a grace of 59 seconds', { orphanGraceSeconds: 59 }],
    ['a grace above 30 days', { orphanGraceSeconds: 2_592_001 }],
    ['an alt text length of zero', { altTextMaxLength: 0 }],
    ['an alt text length above the ceiling', { altTextMaxLength: GIG_ALT_TEXT_CEILING + 1 }],
    ['an unknown property', { extra: 1 }],
  ])('refuses %s', (_what, over) => {
    expect(ok(ProviderGigMediaPolicy.safeParse({ ...valid, ...over }))).toBe(false);
  });
  it('allows equal minimum and maximum edges (the shorter side may equal the longer)', () => {
    expect(ok(ProviderGigMediaPolicy.safeParse({ ...valid, minEdgePixels: 500, maxEdgePixels: 500 }))).toBe(true);
    expect(ok(ProviderGigMediaPolicy.safeParse({ ...valid, minEdgePixels: 501, maxEdgePixels: 500 }))).toBe(false);
  });
});
