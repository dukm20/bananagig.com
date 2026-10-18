// Unit tests of the Gig media (CAT-004) that need no database: the pure image signature and HEADER dimension readers (with hostile input), the media rules of a publish and of the
// menu, the DTOs, and the input validation that must happen BEFORE any store, scanner or statement is touched. Behaviour that needs real constraints, triggers, locks, the audit
// trail and the object store flow is covered in gig-media.itest.ts.
import { MemoryObjectStore } from '@bananagig/platform';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderGigMediaPolicy } from '@bananagig/contracts';
import type { Database } from '@bananagig/database';
import { DEFAULT_GIG_MEDIA_POLICY, StaticGigPolicyProvider } from './gig-policy';
import { GigError } from './gig-errors';
import { GigMediaService, matchesImageSignature, readImageDimensions } from './gig-media';
import { mediaIssues, mediaSummary, toMediaDtos, type GigMediaRow } from './gig-media-model';
import type { DraftMutator, DraftReadContext, GigMediaScanner, GigTemplateFieldFacts, GigTemplateStructure } from './gig-types';

// ---------------------------------------------------------------- image builders (headers only: the reader never decodes)
const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u24le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const bytes = (...parts: (number | number[])[]): Buffer => Buffer.from(parts.flat());

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (w: number, h: number, over: { chunk?: string; length?: number } = {}): Buffer =>
  bytes(PNG_SIG, u32be(over.length ?? 13), ascii(over.chunk ?? 'IHDR'), u32be(w), u32be(h), [8, 2, 0, 0, 0], u32be(0), u32be(0), ascii('IEND'), u32be(0));
const jpeg = (w: number, h: number, over: { marker?: number; precision?: number; components?: number } = {}): Buffer =>
  bytes(
    [0xff, 0xd8],
    [0xff, 0xe0, 0x00, 0x10],
    ascii('JFIF'),
    [0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00],
    [0xff, over.marker ?? 0xc0, 0x00, 0x11, over.precision ?? 8, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, over.components ?? 3],
    [1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    [0xff, 0xda, 0x00, 0x02],
    [0xff, 0xd9],
  );
const riff = (...chunks: number[][]): Buffer => {
  const body = bytes(ascii('WEBP'), chunks.flat());
  return bytes(ascii('RIFF'), u32le(body.length), [...body]);
};
const webpX = (w: number, h: number): Buffer => riff([...ascii('VP8X'), ...u32le(10), 0x10, 0, 0, 0, ...u24le(w - 1), ...u24le(h - 1)]);
const webpL = (w: number, h: number): Buffer => riff([...ascii('VP8L'), ...u32le(5), 0x2f, ...u32le((w - 1) | ((h - 1) << 14)), 0, 0, 0].slice(0, 8 + 5 + 1));
const webpLossy = (w: number, h: number, over: { keyFrame?: boolean; start?: number[] } = {}): Buffer =>
  riff([
    ...ascii('VP8 '),
    ...u32le(10),
    over.keyFrame === false ? 0x11 : 0x10,
    0x02,
    0x00,
    ...(over.start ?? [0x9d, 0x01, 0x2a]),
    w & 0xff,
    (w >> 8) & 0x3f,
    h & 0xff,
    (h >> 8) & 0x3f,
  ]);

describe('matchesImageSignature', () => {
  it('accepts the signature of each declared type and nothing else', () => {
    expect(matchesImageSignature('image/png', png(10, 10))).toBe(true);
    expect(matchesImageSignature('image/jpeg', jpeg(10, 10))).toBe(true);
    expect(matchesImageSignature('image/webp', webpX(10, 10))).toBe(true);
    // a renamed file: the declared type must match the bytes
    expect(matchesImageSignature('image/jpeg', png(10, 10))).toBe(false);
    expect(matchesImageSignature('image/png', jpeg(10, 10))).toBe(false);
    expect(matchesImageSignature('image/webp', png(10, 10))).toBe(false);
    expect(matchesImageSignature('image/png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(false);
    expect(matchesImageSignature('image/png', Buffer.from('<html><script>alert(1)</script></html>'))).toBe(false);
  });
  it('refuses a type this build cannot verify (HEIC, SVG, GIF, PDF) and inherited object names', () => {
    for (const t of ['image/heic', 'image/svg+xml', 'image/gif', 'application/pdf', '', 'constructor', '__proto__', 'toString', 'IMAGE/PNG'])
      expect(matchesImageSignature(t, png(10, 10)), t).toBe(false);
  });
  it('needs the whole signature: every strict prefix of it fails', () => {
    for (let n = 0; n < 8; n++) expect(matchesImageSignature('image/png', png(10, 10).subarray(0, n))).toBe(false);
    for (let n = 0; n < 3; n++) expect(matchesImageSignature('image/jpeg', jpeg(10, 10).subarray(0, n))).toBe(false);
    for (let n = 0; n < 12; n++) expect(matchesImageSignature('image/webp', webpX(10, 10).subarray(0, n))).toBe(false);
    expect(matchesImageSignature('image/png', Buffer.alloc(0))).toBe(false);
  });
  it('a WebP needs both RIFF and WEBP, with any size in between', () => {
    const w = webpX(10, 10);
    const noWebp = Buffer.from(w);
    noWebp.write('WEBX', 8, 'ascii');
    expect(matchesImageSignature('image/webp', noWebp)).toBe(false);
    const wave = Buffer.from(w);
    wave.write('WAVE', 8, 'ascii');
    expect(matchesImageSignature('image/webp', wave)).toBe(false);
    const noRiff = Buffer.from(w);
    noRiff.write('RIFX', 0, 'ascii');
    expect(matchesImageSignature('image/webp', noRiff)).toBe(false);
  });
});

describe('readImageDimensions', () => {
  it('reads PNG from the IHDR chunk', () => {
    expect(readImageDimensions('image/png', png(640, 480))).toEqual({ width: 640, height: 480 });
    expect(readImageDimensions('image/png', png(1, 1))).toEqual({ width: 1, height: 1 });
  });
  it('reads JPEG from the start-of-frame marker, baseline and progressive, after other segments', () => {
    expect(readImageDimensions('image/jpeg', jpeg(800, 600))).toEqual({ width: 800, height: 600 });
    expect(readImageDimensions('image/jpeg', jpeg(800, 600, { marker: 0xc2 }))).toEqual({ width: 800, height: 600 });
    expect(readImageDimensions('image/jpeg', jpeg(65535, 65535))).toEqual({ width: 65535, height: 65535 });
    // fill bytes (0xFF 0xFF ...) before a marker are legal padding
    const padded = bytes([0xff, 0xd8], [0xff, 0xff, 0xff, 0xe0, 0x00, 0x04, 0, 0], [0xff, 0xff, 0xc0, 0x00, 0x0b, 8, 0, 20, 0, 30, 1, 1, 0x11, 0]);
    expect(readImageDimensions('image/jpeg', padded)).toEqual({ width: 30, height: 20 });
    // restart and temporary markers carry no length
    const rst = bytes([0xff, 0xd8], [0xff, 0x01], [0xff, 0xd0], [0xff, 0xc0, 0x00, 0x0b, 8, 0, 7, 0, 9, 1, 1, 0x11, 0]);
    expect(readImageDimensions('image/jpeg', rst)).toEqual({ width: 9, height: 7 });
  });
  it('reads WebP in its three layouts: extended (VP8X), lossless (VP8L) and lossy (VP8)', () => {
    expect(readImageDimensions('image/webp', webpX(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(readImageDimensions('image/webp', webpX(16_777_216, 16_777_216))).toEqual({ width: 16_777_216, height: 16_777_216 });
    expect(readImageDimensions('image/webp', webpL(500, 300))).toEqual({ width: 500, height: 300 });
    expect(readImageDimensions('image/webp', webpL(16384, 16384))).toEqual({ width: 16384, height: 16384 });
    expect(readImageDimensions('image/webp', webpLossy(321, 123))).toEqual({ width: 321, height: 123 });
  });
  it('reports the claimed size of a decompression bomb (a tiny file claiming a huge image) so the caller can refuse it', () => {
    const bomb = png(2_147_483_647, 2_147_483_647);
    expect(bomb.byteLength).toBeLessThan(100);
    expect(readImageDimensions('image/png', bomb)).toEqual({ width: 2_147_483_647, height: 2_147_483_647 });
    expect(readImageDimensions('image/jpeg', jpeg(65535, 65535))!.width * 65535).toBeGreaterThan(4_000_000_000);
  });
  it('is null for the wrong type, an unknown type or an inherited name', () => {
    expect(readImageDimensions('image/jpeg', png(10, 10))).toBeNull();
    expect(readImageDimensions('image/png', jpeg(10, 10))).toBeNull();
    expect(readImageDimensions('image/webp', jpeg(10, 10))).toBeNull();
    for (const t of ['image/gif', 'image/heic', 'image/svg+xml', 'constructor', '', '__proto__']) expect(readImageDimensions(t, png(10, 10)), t).toBeNull();
  });

  describe('hostile PNG', () => {
    it('is null when the first chunk is not IHDR, when its length is not 13, or when a size is zero or beyond 2^31-1', () => {
      expect(readImageDimensions('image/png', png(10, 10, { chunk: 'IDAT' }))).toBeNull();
      expect(readImageDimensions('image/png', png(10, 10, { chunk: 'iHDR' }))).toBeNull();
      expect(readImageDimensions('image/png', png(10, 10, { length: 12 }))).toBeNull();
      expect(readImageDimensions('image/png', png(10, 10, { length: 0xffffffff }))).toBeNull();
      expect(readImageDimensions('image/png', png(0, 10))).toBeNull();
      expect(readImageDimensions('image/png', png(10, 0))).toBeNull();
      expect(readImageDimensions('image/png', png(0x80000000, 10))).toBeNull();
      expect(readImageDimensions('image/png', png(10, 0xffffffff))).toBeNull();
    });
    it('is null for every truncation of the header', () => {
      const whole = png(40, 40);
      for (let n = 0; n < 24; n++) expect(readImageDimensions('image/png', whole.subarray(0, n)), `prefix ${n}`).toBeNull();
    });
  });

  describe('hostile JPEG', () => {
    it('is null for every truncation before the frame header is complete, and never throws', () => {
      const whole = jpeg(40, 30);
      const sof = whole.indexOf(0xc0, 4);
      for (let n = 0; n < sof + 9; n++) expect(readImageDimensions('image/jpeg', whole.subarray(0, n)), `prefix ${n}`).toBeNull();
    });
    it('is null for a zero size (height 0 is a DNL-defined size), a bad precision or no components', () => {
      expect(readImageDimensions('image/jpeg', jpeg(0, 10))).toBeNull();
      expect(readImageDimensions('image/jpeg', jpeg(10, 0))).toBeNull();
      expect(readImageDimensions('image/jpeg', jpeg(10, 10, { precision: 0 }))).toBeNull();
      expect(readImageDimensions('image/jpeg', jpeg(10, 10, { precision: 3 }))).toBeNull();
      expect(readImageDimensions('image/jpeg', jpeg(10, 10, { components: 0 }))).toBeNull();
    });
    it('skips DHT (0xC4), JPG (0xC8) and DAC (0xCC): they are not frame headers', () => {
      for (const marker of [0xc4, 0xc8, 0xcc]) expect(readImageDimensions('image/jpeg', jpeg(10, 10, { marker }))).toBeNull();
    });
    it('is null when the scan or the end of the image comes before any frame header', () => {
      expect(readImageDimensions('image/jpeg', bytes([0xff, 0xd8], [0xff, 0xda, 0x00, 0x02], [1, 2, 3]))).toBeNull();
      expect(readImageDimensions('image/jpeg', bytes([0xff, 0xd8], [0xff, 0xd9]))).toBeNull();
      expect(readImageDimensions('image/jpeg', bytes([0xff, 0xd8, 0xff]))).toBeNull();
    });
    it('is null for a segment whose length is below 2 or runs past the end (so the walk can neither loop nor read out of bounds)', () => {
      expect(
        readImageDimensions('image/jpeg', bytes([0xff, 0xd8], [0xff, 0xe0, 0x00, 0x00], [0xff, 0xc0, 0x00, 0x0b, 8, 0, 9, 0, 9, 1, 1, 0x11, 0])),
      ).toBeNull();
      expect(
        readImageDimensions('image/jpeg', bytes([0xff, 0xd8], [0xff, 0xe0, 0x00, 0x01], [0xff, 0xc0, 0x00, 0x0b, 8, 0, 9, 0, 9, 1, 1, 0x11, 0])),
      ).toBeNull();
      expect(readImageDimensions('image/jpeg', bytes([0xff, 0xd8], [0xff, 0xe0, 0xff, 0xff], [0, 0, 0]))).toBeNull();
      // a frame header shorter than its mandatory part
      expect(readImageDimensions('image/jpeg', bytes([0xff, 0xd8], [0xff, 0xc0, 0x00, 0x05, 8, 0, 9]))).toBeNull();
    });
    it('is null for bytes that are not marker-aligned after the signature', () => {
      expect(readImageDimensions('image/jpeg', bytes([0xff, 0xd8, 0xff], [0x00, 0x10, 0x00, 0x00]))).toBeNull();
      expect(readImageDimensions('image/jpeg', bytes([0xff, 0xd8], [0x12, 0x34, 0x56, 0x78]))).toBeNull();
    });
    it('walks a very long run of fill bytes and many tiny segments in linear time', () => {
      const fill = Buffer.concat([bytes([0xff, 0xd8]), Buffer.alloc(5_000_000, 0xff)]);
      const t0 = Date.now();
      expect(readImageDimensions('image/jpeg', fill)).toBeNull();
      const tiny = Buffer.concat([bytes([0xff, 0xd8]), ...Array.from({ length: 200_000 }, () => bytes([0xff, 0xe1, 0x00, 0x02]))]);
      expect(readImageDimensions('image/jpeg', tiny)).toBeNull();
      expect(Date.now() - t0).toBeLessThan(2000);
    });
  });

  describe('hostile WebP', () => {
    it('is null when the declared container size exceeds the bytes (a truncated file), or the chunk size does', () => {
      const w = webpX(100, 100);
      expect(readImageDimensions('image/webp', w.subarray(0, w.byteLength - 1))).toBeNull();
      const lie = Buffer.from(w);
      lie.writeUInt32LE(0xffffffff, 4);
      expect(readImageDimensions('image/webp', lie)).toBeNull();
      const chunkLie = Buffer.from(w);
      chunkLie.writeUInt32LE(0xffffffff, 16);
      expect(readImageDimensions('image/webp', chunkLie)).toBeNull();
    });
    it('is null for an unknown first chunk, a short chunk or a bad VP8L / VP8 header', () => {
      expect(readImageDimensions('image/webp', riff([...ascii('ANIM'), ...u32le(6), 0, 0, 0, 0, 0, 0]))).toBeNull();
      expect(readImageDimensions('image/webp', riff([...ascii('VP8X'), ...u32le(4), 0, 0, 0, 0]))).toBeNull();
      expect(readImageDimensions('image/webp', riff([...ascii('VP8L'), ...u32le(4), 0x2f, 0, 0, 0]))).toBeNull();
      expect(readImageDimensions('image/webp', riff([...ascii('VP8L'), ...u32le(6), 0x2e, 0, 0, 0, 0, 0]))).toBeNull();
      expect(readImageDimensions('image/webp', webpLossy(100, 100, { keyFrame: false }))).toBeNull();
      expect(readImageDimensions('image/webp', webpLossy(100, 100, { start: [0x9d, 0x01, 0x2b] }))).toBeNull();
      expect(readImageDimensions('image/webp', webpLossy(0, 100))).toBeNull();
      expect(readImageDimensions('image/webp', webpLossy(100, 0))).toBeNull();
    });
    it('is null for every truncation of the first 30 bytes, and never throws', () => {
      for (const w of [webpX(64, 64), webpL(64, 64), webpLossy(64, 64)])
        for (let n = 0; n < Math.min(w.byteLength, 30); n++) expect(readImageDimensions('image/webp', w.subarray(0, n)), `prefix ${n}`).toBeNull();
    });
  });

  it('never throws on garbage: empty input, single bytes, random bytes behind each signature', () => {
    let seed = 12345;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 8) & 0xff;
    const noise = (n: number): number[] => Array.from({ length: n }, rnd);
    const types = ['image/png', 'image/jpeg', 'image/webp'];
    const heads = [PNG_SIG, [0xff, 0xd8, 0xff], [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')]];
    for (const [i, t] of types.entries()) {
      expect(readImageDimensions(t, Buffer.alloc(0))).toBeNull();
      expect(readImageDimensions(t, Buffer.from([0]))).toBeNull();
      for (let k = 0; k < 200; k++) {
        const b = bytes(heads[i]!, noise(rnd() % 80));
        const r = readImageDimensions(t, b);
        if (r !== null) {
          expect(r.width).toBeGreaterThanOrEqual(1);
          expect(r.height).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });
});

// ---------------------------------------------------------------- what the header reader does and does NOT verify
// The reader looks at the HEADER only and never decodes: that is a deliberate bound (no image library in the process that handles hostile uploads; a phone JPEG may legitimately carry
// trailing data, maker notes and thumbnails). These tests document the boundary so nobody mistakes the check for image validation.
describe('what the header-only reader verifies, and what it does not', () => {
  it('VERIFIES: the declared type matches the signature, and the container header is well formed and states a size', () => {
    expect(matchesImageSignature('image/png', png(640, 480))).toBe(true);
    expect(readImageDimensions('image/png', png(640, 480))).toEqual({ width: 640, height: 480 });
  });
  it('does NOT verify the image data: a PNG with an IHDR and nothing else (no IDAT) is accepted', () => {
    const onlyHeader = bytes(PNG_SIG, u32be(13), ascii('IHDR'), u32be(300), u32be(200), [8, 2, 0, 0, 0], u32be(0));
    expect(readImageDimensions('image/png', onlyHeader)).toEqual({ width: 300, height: 200 });
  });
  it('does NOT verify the end of a JPEG: data after the frame header, a scan cut short or arbitrary trailing bytes (a phone photo carries trailing data) are accepted', () => {
    const good = jpeg(800, 600);
    expect(readImageDimensions('image/jpeg', Buffer.concat([good, Buffer.from('trailing maker data and a thumbnail that is not an image', 'ascii')]))).toEqual({
      width: 800,
      height: 600,
    });
    const sof = good.indexOf(0xc0, 4);
    const cutAfterFrameHeader = good.subarray(0, sof + 18);
    expect(readImageDimensions('image/jpeg', cutAfterFrameHeader)).toEqual({ width: 800, height: 600 });
    expect(readImageDimensions('image/jpeg', Buffer.concat([cutAfterFrameHeader, Buffer.alloc(1000, 0x41)]))).toEqual({ width: 800, height: 600 });
  });
  it('does NOT verify the WebP payload: a lossless header followed by garbage is accepted as long as the declared container fits', () => {
    const w = webpL(256, 256);
    const garbage = riff([...ascii('VP8L'), ...u32le(5), 0x2f, ...u32le(255 | (255 << 14)), 0], [...ascii('JUNK'), ...u32le(8), 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(readImageDimensions('image/webp', w)).toEqual({ width: 256, height: 256 });
    expect(readImageDimensions('image/webp', garbage)).toEqual({ width: 256, height: 256 });
  });
  it('does NOT verify that the claimed size is real: only the policy bounds (edges, pixels) stand between a lying header and the store', () => {
    const lying = png(11_000, 11_000); // a few dozen bytes claiming 121 megapixels
    expect(lying.byteLength).toBeLessThan(100);
    expect(readImageDimensions('image/png', lying)).toEqual({ width: 11_000, height: 11_000 });
  });
  it('does NOT detect polyglots: a valid PNG header followed by markup or script is still a PNG to this reader (the object is served inline with its stored content type, never sniffed)', () => {
    const polyglot = Buffer.concat([png(400, 400), Buffer.from('<script>alert(1)</script>')]);
    expect(matchesImageSignature('image/png', polyglot)).toBe(true);
    expect(readImageDimensions('image/png', polyglot)).toEqual({ width: 400, height: 400 });
  });
});

// ---------------------------------------------------------------- the media rules
const field = (over: Partial<GigTemplateFieldFacts> & { fieldKey: string }): GigTemplateFieldFacts => ({
  gigTemplateFieldId: `field-${over.fieldKey}`,
  fieldType: 'MEDIA',
  section: 'DETAILS',
  behavior: 'PROVIDER_CONFIGURABLE',
  customerVisible: true,
  displayOrder: 1,
  labelContentKey: 'label',
  helpContentKey: null,
  defaultContentKey: null,
  defaultNumber: null,
  defaultBoolean: null,
  defaultOption: null,
  minLength: null,
  maxLength: null,
  minNumber: null,
  maxNumber: null,
  minItems: null,
  maxItems: null,
  options: [],
  ...over,
});
const structureOf = (fields: GigTemplateFieldFacts[]): GigTemplateStructure => ({
  gigTemplateId: 't',
  gigTemplateCode: 'tpl',
  templateStatus: 'ACTIVE',
  serviceTypeCode: 'st',
  serviceTypeStatus: 'ACTIVE',
  categoryCode: 'c',
  nameContentKey: 'n',
  descriptionContentKey: null,
  instructionsContentKey: null,
  gigTemplateVersionId: 'tv',
  versionNumber: 1,
  versionStatus: 'ACTIVE',
  duration: { minMinutes: null, maxMinutes: null, suggestedMinutes: null },
  pricing: { fixed: true, fixedWithVariants: false },
  addOnsAllowed: false,
  fields,
  requirements: [],
});
let n = 0;
const row = (over: Partial<GigMediaRow> & { fieldKey: string }): GigMediaRow => {
  n++;
  return {
    mediaId: `m${n}`,
    gigVersionId: 'v1',
    assetId: `a${n}`,
    gigTemplateFieldId: `field-${over.fieldKey}`,
    displayOrder: n,
    altText: null,
    assetStatus: 'READY',
    scanStatus: 'CLEAN',
    mimeType: 'image/png',
    sizeBytes: 1000,
    width: 800,
    height: 600,
    ...over,
  };
};
const policy = (over: Partial<ProviderGigMediaPolicy> = {}): ProviderGigMediaPolicy => ({ ...DEFAULT_GIG_MEDIA_POLICY, ...over });
const tag = (issues: ReturnType<typeof mediaIssues>): string[] => issues.map((i) => `${i.reason}${i.fieldKey ? `:${i.fieldKey}` : ''}`);

describe('mediaIssues', () => {
  const required = field({ fieldKey: 'photos', behavior: 'PROVIDER_REQUIRED', minItems: 2, maxItems: 3 });
  const optional = field({ fieldKey: 'extras', displayOrder: 2, maxItems: 1 });
  const none = field({ fieldKey: 'banned', displayOrder: 3, maxItems: 0 });
  const s = structureOf([required, optional, none]);

  it('a required field needs its minimum of READY photos; an optional one needs none', () => {
    expect(tag(mediaIssues([], s, policy()))).toEqual(['MEDIA_REQUIRED:photos']);
    expect(tag(mediaIssues([row({ fieldKey: 'photos' })], s, policy()))).toEqual(['MEDIA_REQUIRED:photos']);
    expect(mediaIssues([row({ fieldKey: 'photos' }), row({ fieldKey: 'photos' })], s, policy())).toEqual([]);
  });
  it('a required field with no stated minimum needs at least one', () => {
    const lax = structureOf([field({ fieldKey: 'photos', behavior: 'PROVIDER_REQUIRED' })]);
    expect(tag(mediaIssues([], lax, policy()))).toEqual(['MEDIA_REQUIRED:photos']);
    expect(mediaIssues([row({ fieldKey: 'photos' })], lax, policy())).toEqual([]);
  });
  it('a field over its maximum is refused, and a prohibited field takes none', () => {
    const four = [1, 2, 3, 4].map(() => row({ fieldKey: 'photos' }));
    expect(tag(mediaIssues(four, s, policy()))).toEqual(['MEDIA_TOO_MANY:photos']);
    expect(tag(mediaIssues([...[1, 2].map(() => row({ fieldKey: 'photos' })), row({ fieldKey: 'banned' })], s, policy()))).toEqual([
      'MEDIA_NOT_PERMITTED:banned',
    ]);
  });
  it('an unfinished upload blocks the publish and does not count toward the minimum', () => {
    const pending = row({ fieldKey: 'photos', assetStatus: 'UPLOAD_PENDING', scanStatus: 'PENDING' });
    const issues = mediaIssues([row({ fieldKey: 'photos' }), pending], s, policy());
    expect(tag(issues)).toEqual(['MEDIA_NOT_READY:photos', 'MEDIA_REQUIRED:photos']);
    expect(issues[0]!.itemKey).toBe(pending.mediaId);
    expect(issues[0]!.target).toBe('media');
  });
  it('with clean scans required a READY photo whose verdict was ERROR does not count; without the requirement it does', () => {
    const errored = [row({ fieldKey: 'photos', scanStatus: 'ERROR' }), row({ fieldKey: 'photos', scanStatus: 'ERROR' })];
    expect(tag(mediaIssues(errored, s, policy({ requireCleanScan: true })))).toEqual([
      'MEDIA_NOT_READY:photos',
      'MEDIA_NOT_READY:photos',
      'MEDIA_REQUIRED:photos',
    ]);
    expect(mediaIssues(errored, s, policy({ requireCleanScan: false }))).toEqual([]);
  });
  it('a photo of a field the template version does not have is a MEDIA_FIELD_UNKNOWN issue', () => {
    expect(tag(mediaIssues([row({ fieldKey: 'ghost' }), row({ fieldKey: 'photos' }), row({ fieldKey: 'photos' })], s, policy()))).toEqual([
      'MEDIA_FIELD_UNKNOWN:ghost',
    ]);
    expect(tag(mediaIssues([row({ fieldKey: 'x' })], structureOf([]), policy()))).toEqual(['MEDIA_FIELD_UNKNOWN:x']);
  });
  it('the total is capped by the configured maximum', () => {
    const rows = [row({ fieldKey: 'extras' })];
    expect(tag(mediaIssues(rows, s, policy({ maxItems: 0 })))).toContain('MEDIA_TOTAL_EXCEEDED');
    expect(tag(mediaIssues([row({ fieldKey: 'photos' }), row({ fieldKey: 'photos' }), row({ fieldKey: 'extras' })], s, policy({ maxItems: 3 })))).toEqual([]);
    expect(tag(mediaIssues([row({ fieldKey: 'photos' }), row({ fieldKey: 'photos' }), row({ fieldKey: 'extras' })], s, policy({ maxItems: 2 })))).toEqual([
      'MEDIA_TOTAL_EXCEEDED',
    ]);
  });
  it('carries identifiers and message keys only', () => {
    for (const i of mediaIssues([row({ fieldKey: 'photos', assetStatus: 'UPLOAD_PENDING', altText: 'zebra alt' })], s, policy())) {
      expect(i.messageKey).toBe(`provider.gig.issue.${i.reason.toLowerCase()}`);
      expect(JSON.stringify(i)).not.toContain('zebra');
    }
  });
  it('a version without a MEDIA field and without photos has no issue', () => {
    expect(mediaIssues([], structureOf([field({ fieldKey: 'notes', fieldType: 'TEXT' })]), policy())).toEqual([]);
  });
});

describe('an unfinished upload never counts as a delivered photo, whatever the scan requirement (mutation-testing additions)', () => {
  const s = structureOf([field({ fieldKey: 'photos', behavior: 'PROVIDER_REQUIRED', minItems: 1, maxItems: 2 })]);
  const pending = () => row({ fieldKey: 'photos', assetStatus: 'UPLOAD_PENDING', scanStatus: 'PENDING' });
  it('without the clean-scan requirement a pending photo is still MEDIA_NOT_READY and does not satisfy the minimum', () => {
    expect(tag(mediaIssues([pending()], s, policy({ requireCleanScan: false })))).toEqual(['MEDIA_NOT_READY:photos', 'MEDIA_REQUIRED:photos']);
    expect(mediaSummary([pending()], s, policy({ requireCleanScan: false }))).toEqual({ mediaCount: 0, mediaRequirementSatisfied: false });
    // a pending photo whose scan row already says ERROR (an earlier attempt) is the same
    expect(
      tag(mediaIssues([row({ fieldKey: 'photos', assetStatus: 'UPLOAD_PENDING', scanStatus: 'ERROR' })], s, policy({ requireCleanScan: false }))),
    ).toContain('MEDIA_NOT_READY:photos');
  });
});

describe('mediaSummary', () => {
  const s = structureOf([field({ fieldKey: 'photos', behavior: 'PROVIDER_REQUIRED', minItems: 1, maxItems: 2 })]);
  it('counts READY photos and says whether the requirement is met', () => {
    expect(mediaSummary([], s, policy())).toEqual({ mediaCount: 0, mediaRequirementSatisfied: false });
    expect(mediaSummary([row({ fieldKey: 'photos' })], s, policy())).toEqual({ mediaCount: 1, mediaRequirementSatisfied: true });
    expect(mediaSummary([row({ fieldKey: 'photos', assetStatus: 'UPLOAD_PENDING', scanStatus: 'PENDING' })], s, policy())).toEqual({
      mediaCount: 0,
      mediaRequirementSatisfied: false,
    });
    expect(
      mediaSummary(
        [1, 2, 3].map(() => row({ fieldKey: 'photos' })),
        s,
        policy(),
      ),
    ).toEqual({ mediaCount: 3, mediaRequirementSatisfied: false });
  });
  it('is satisfied when the template version has no MEDIA field', () => {
    expect(mediaSummary([], structureOf([]), policy())).toEqual({ mediaCount: 0, mediaRequirementSatisfied: true });
  });
});

describe('toMediaDtos', () => {
  it('orders by display order, says UPLOADING until READY, hides dimensions of an unfinished upload and exposes no asset id, key or hash', () => {
    const a = row({ fieldKey: 'photos', displayOrder: 2, altText: 'front' });
    const b = row({ fieldKey: 'photos', displayOrder: 1, assetStatus: 'UPLOAD_PENDING', scanStatus: 'PENDING', width: null, height: null });
    const dtos = toMediaDtos([a, b]);
    expect(dtos.map((d) => [d.mediaId, d.displayOrder, d.status])).toEqual([
      [b.mediaId, 1, 'UPLOADING'],
      [a.mediaId, 2, 'READY'],
    ]);
    expect(dtos[1]).toEqual({
      mediaId: a.mediaId,
      fieldKey: 'photos',
      displayOrder: 2,
      status: 'READY',
      mimeType: 'image/png',
      sizeBytes: 1000,
      width: 800,
      height: 600,
      altText: 'front',
    });
    expect(Object.keys(dtos[0]!).sort()).toEqual(['altText', 'displayOrder', 'fieldKey', 'height', 'mediaId', 'mimeType', 'sizeBytes', 'status', 'width']);
    expect(JSON.stringify(dtos)).not.toContain(a.assetId);
  });
});

// ---------------------------------------------------------------- the service: refusals that happen before anything is touched
const sentinel = (what: string) => () => {
  throw new Error(`unexpected ${what}`);
};
const DRAFT: DraftReadContext = {
  gigId: 'g1',
  gigStatus: 'DRAFT',
  draft: { gigVersionId: 'v1', versionNumber: 1, revision: 4, gigTemplateVersionId: 'tv' },
  structure: structureOf([
    field({ fieldKey: 'photos', behavior: 'PROVIDER_REQUIRED', minItems: 1, maxItems: 3 }),
    field({ fieldKey: 'banned', displayOrder: 2, maxItems: 0 }),
    field({ fieldKey: 'fixed', displayOrder: 3, behavior: 'PLATFORM_FIXED' }),
    field({ fieldKey: 'notes', displayOrder: 4, fieldType: 'TEXT' }),
  ]),
  currency: 'USD',
};
function build(over: { readDraft?: DraftMutator['readDraft']; policy?: StaticGigPolicyProvider } = {}) {
  const calls = { readDraft: 0, mutateDraft: 0, scans: 0 };
  const store = new MemoryObjectStore();
  const scanner: GigMediaScanner = { scan: vi.fn(async () => (calls.scans++, { status: 'CLEAN' as const })) };
  const drafts: DraftMutator = {
    readDraft: over.readDraft ?? (async () => (calls.readDraft++, DRAFT)),
    mutateDraft: (async () => {
      calls.mutateDraft++;
      throw new Error('unexpected mutateDraft');
    }) as DraftMutator['mutateDraft'],
  };
  const database = new Proxy({}, { get: sentinel('database use') }) as unknown as Database;
  const pol = over.policy ?? new StaticGigPolicyProvider({ maxActive: 1, maxDrafts: 1, titleMaxLength: 1, shortPitchMaxLength: 1, descriptionMaxLength: 1 });
  const svc = new GigMediaService({ database, store, scanner, policy: pol, drafts });
  return { svc, calls, store, pol };
}
const upload = (over: Record<string, unknown> = {}) => ({
  expectedRevision: 4,
  fieldKey: 'photos',
  mimeType: 'image/png',
  sizeBytes: 5000,
  altText: null,
  ...over,
});
const code = async (p: Promise<unknown>): Promise<GigError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GigError);
    return e as GigError;
  }
  throw new Error('expected a GigError');
};

describe('GigMediaService.requestUpload refusals', () => {
  it('rejects an invalid or unknown-key body before reading anything', async () => {
    const { svc, calls } = build();
    for (const body of [
      null,
      'x',
      {},
      upload({ extra: 1 }),
      upload({ expectedRevision: 0 }),
      upload({ sizeBytes: 0 }),
      upload({ sizeBytes: 26_214_401 }),
      upload({ sha256: 'AB' }),
    ]) {
      expect((await code(svc.requestUpload('a1', 'g1', body))).code).toBe('VALIDATION_FAILED');
    }
    expect(calls.readDraft).toBe(0);
  });
  it('fails closed when the media policy is unavailable', async () => {
    const pol = new StaticGigPolicyProvider({ maxActive: 1, maxDrafts: 1, titleMaxLength: 1, shortPitchMaxLength: 1, descriptionMaxLength: 1 });
    pol.failure = new GigError('UNAVAILABLE', 'the Gig policy is not available', { reason: 'POLICY_INVALID' });
    const { svc, calls } = build({ policy: pol });
    const e = await code(svc.requestUpload('a1', 'g1', upload()));
    expect(e.code).toBe('UNAVAILABLE');
    expect(calls.readDraft).toBe(0);
  });
  it('a foreign or unknown Gig answers the 404 of the draft read whatever the body says', async () => {
    const { svc } = build({ readDraft: async () => Promise.reject(new GigError('GIG_NOT_FOUND', 'the Gig was not found', {})) });
    expect((await code(svc.requestUpload('a1', 'g1', upload({ mimeType: 'application/x-evil', sizeBytes: 20_000_000 })))).code).toBe('GIG_NOT_FOUND');
  });
  it('a stale revision is refused before anything else', async () => {
    const { svc, calls } = build();
    expect((await code(svc.requestUpload('a1', 'g1', upload({ expectedRevision: 3 })))).code).toBe('STALE_DRAFT');
    expect(calls.mutateDraft).toBe(0);
  });
  it('refuses a type outside the configuration and a size above the configured maximum, with a reason code only', async () => {
    const { svc, calls } = build();
    for (const mimeType of ['image/heic', 'image/svg+xml', 'image/gif', 'application/pdf', 'IMAGE/PNG', 'image/png; charset=x']) {
      const e = await code(svc.requestUpload('a1', 'g1', upload({ mimeType })));
      expect([e.code, e.details.reason]).toEqual(['MEDIA_REFUSED', 'MIME_NOT_ALLOWED']);
    }
    const big = await code(svc.requestUpload('a1', 'g1', upload({ sizeBytes: DEFAULT_GIG_MEDIA_POLICY.maxFileSizeBytes + 1 })));
    expect([big.code, big.details.reason]).toEqual(['MEDIA_REFUSED', 'FILE_TOO_LARGE']);
    expect(calls.mutateDraft).toBe(0);
  });
  it('a type removed from the allowed list is refused even though the build could verify it', async () => {
    const { svc, pol } = build();
    pol.mediaValue = { ...DEFAULT_GIG_MEDIA_POLICY, allowedMimeTypes: ['image/jpeg'] };
    expect((await code(svc.requestUpload('a1', 'g1', upload()))).details.reason).toBe('MIME_NOT_ALLOWED');
  });
  it('refuses a field the template version does not have, a non-MEDIA field, a prohibited field and a platform-fixed one', async () => {
    const { svc } = build();
    const unknown = await code(svc.requestUpload('a1', 'g1', upload({ fieldKey: 'ghost' })));
    expect([unknown.code, unknown.details.reason, (unknown.details.issues as { reason: string }[])[0]!.reason]).toEqual([
      'VALIDATION_FAILED',
      'MEDIA_INVALID',
      'MEDIA_FIELD_UNKNOWN',
    ]);
    expect(((await code(svc.requestUpload('a1', 'g1', upload({ fieldKey: 'notes' })))).details.issues as { reason: string }[])[0]!.reason).toBe(
      'MEDIA_FIELD_UNKNOWN',
    );
    expect(((await code(svc.requestUpload('a1', 'g1', upload({ fieldKey: 'banned' })))).details.issues as { reason: string }[])[0]!.reason).toBe(
      'MEDIA_NOT_PERMITTED',
    );
    expect(((await code(svc.requestUpload('a1', 'g1', upload({ fieldKey: 'fixed' })))).details.issues as { reason: string }[])[0]!.reason).toBe(
      'MEDIA_NOT_PERMITTED',
    );
  });
  it('refuses alt text that is too long, has markup or has control characters; the issue never echoes the text', async () => {
    const { svc } = build();
    for (const [altText, reason] of [
      ['x'.repeat(DEFAULT_GIG_MEDIA_POLICY.altTextMaxLength + 1), 'MEDIA_ALT_TOO_LONG'],
      ['<b>zebra</b>', 'HTML_NOT_ALLOWED'],
      ['zebra\u0000nul', 'FORBIDDEN_CHARACTER'],
      ['zebra‮evil', 'FORBIDDEN_CHARACTER'],
    ] as const) {
      const e = await code(svc.requestUpload('a1', 'g1', upload({ altText })));
      expect((e.details.issues as { reason: string }[])[0]!.reason).toBe(reason);
      expect(JSON.stringify(e.details) + e.message).not.toContain('zebra');
    }
  });
});

describe('GigMediaService other operations: input is validated first', () => {
  const mid = '11111111-1111-4111-8111-111111111111';
  it('finalize, alt text, detach and reorder refuse malformed bodies and ids without touching the database', async () => {
    const { svc, calls } = build();
    expect((await code(svc.finalize('a1', 'g1', mid, { expectedRevision: 'x' }))).code).toBe('VALIDATION_FAILED');
    expect((await code(svc.finalize('a1', 'g1', mid, { expectedRevision: 1, sha256: 'nope' }))).code).toBe('VALIDATION_FAILED');
    expect((await code(svc.updateAltText('a1', 'g1', mid, { expectedRevision: 1 }))).code).toBe('VALIDATION_FAILED');
    expect((await code(svc.detach('a1', 'g1', mid, { expectedRevision: 1, extra: true }))).code).toBe('VALIDATION_FAILED');
    expect((await code(svc.reorder('a1', 'g1', { expectedRevision: 1, mediaIds: [mid, mid] }))).code).toBe('VALIDATION_FAILED');
    expect((await code(svc.reorder('a1', 'g1', { expectedRevision: 1, mediaIds: ['nope'] }))).code).toBe('VALIDATION_FAILED');
    expect(calls.readDraft).toBe(0);
  });
  it('a media id that is not a UUID is MEDIA_NOT_FOUND (never reaches SQL)', async () => {
    const { svc } = build();
    for (const bad of ['', 'x', "1' OR '1'='1", '../../etc/passwd']) {
      expect((await code(svc.updateAltText('a1', 'g1', bad, { expectedRevision: 4, altText: null }))).code).toBe('MEDIA_NOT_FOUND');
      expect((await code(svc.detach('a1', 'g1', bad, { expectedRevision: 4 }))).code).toBe('MEDIA_NOT_FOUND');
      expect((await code(svc.finalize('a1', 'g1', bad, { expectedRevision: 4 }))).code).toBe('MEDIA_NOT_FOUND');
      expect((await code(svc.preview('a1', mid, null, bad))).code).toBe('MEDIA_NOT_FOUND');
    }
  });
  it('preview with a Gig id that is not a UUID is GIG_NOT_FOUND', async () => {
    const { svc } = build();
    expect((await code(svc.preview('a1', 'not-a-uuid', null, mid))).code).toBe('GIG_NOT_FOUND');
  });
});
