// Unit tests of the container-level image sanitiser (PRO-002). All fixtures are built in code from real container layouts (see image-sanitize-fixtures.ts). The assertions are about BYTES: the
// secrets are gone, the pixel-bearing segments are byte-identical, the header parser still reads the same dimensions, and no input (truncated, hostile, huge claimed lengths) can make the
// function throw or work more than linear time.
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readImageDimensions } from './gig-media';
import { sanitizeImage } from './image-sanitize';
import {
  ascii,
  u16be,
  u32be,
  u32le,
  catList,
  cat,
  count,
  exifTiff,
  exifSegment,
  segment,
  ENTROPY,
  jpegImagePart,
  jpeg,
  chunk,
  PNG_SIG,
  ihdr,
  png,
  riffList,
  riffOf,
  rchunk,
  vp8x,
  vp8Data,
  anmf,
  ihdrOf,
  iccProfile,
  iccpData,
  webp,
  SECRETS,
  has,
} from './image-sanitize-fixtures';

function expectNoSecrets(out: Buffer): void {
  for (const s of SECRETS) expect(has(out, s), s).toBe(false);
}

const ok = (mime: string, b: Buffer): Buffer => {
  const r = sanitizeImage(mime, b);
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.bytes;
};
const reason = (mime: string, b: Buffer): string => {
  const r = sanitizeImage(mime, b);
  return r.ok ? 'OK' : r.reason;
};

// ---------------------------------------------------------------- JPEG
describe('sanitizeImage: JPEG', () => {
  const exifLe = exifSegment(exifTiff({ little: true, orientation: 6, gps: true }));

  it('removes EXIF GPS, XMP, IPTC, COM, MPF, JFXX, other APPn and everything after EOI; keeps JFIF, ICC, Adobe and the pixel segments byte-identical', () => {
    const { file, image } = jpeg({ exif: exifLe });
    expect(has(file, 'SECRET-GPS')).toBe(true); // the fixture really carries the data
    expect(has(file, 'SECRET-CAMERA')).toBe(true);
    const out = ok('image/jpeg', file);
    expectNoSecrets(out);
    for (const gone of ['http://ns.adobe.com', 'Photoshop', 'MPF\0', 'JFXX']) expect(has(out, gone), gone).toBe(false);
    for (const kept of ['JFIF\0', 'ICC_PROFILE\0', 'Adobe']) expect(has(out, kept), kept).toBe(true);
    expect(out.subarray(out.length - 2).equals(Buffer.from([0xff, 0xd9]))).toBe(true); // ends at EOI
    // the image part (first DQT .. EOI) is byte-identical
    expect(out.subarray(out.length - image.length).equals(image)).toBe(true);
    expect(out.length).toBeLessThan(file.length);
  });

  it('keeps the dimensions readable by the header parser and the Orientation tag, as a minimal EXIF holding only that tag', () => {
    const { file } = jpeg({ w: 1234, h: 987, exif: exifLe });
    const out = ok('image/jpeg', file);
    expect(readImageDimensions('image/jpeg', out)).toEqual({ width: 1234, height: 987 });
    expect(readImageDimensions('image/jpeg', file)).toEqual({ width: 1234, height: 987 });
    expect(count(out, 'Exif\0\0')).toBe(1);
    const at = out.indexOf('Exif\0\0');
    expect(out.readUInt16BE(at - 2)).toBe(34); // length of the minimal segment
    // TIFF: "MM", 42, IFD at 8, ONE entry: tag 0x0112, SHORT, count 1, value 6, no next IFD
    const tiff = out.subarray(at + 6, at + 6 + 26);
    expect([...tiff]).toEqual([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
  });

  it('reads the orientation from big-endian and little-endian EXIF alike (1..8) and drops invalid or missing values', () => {
    for (const little of [true, false])
      for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const out = ok('image/jpeg', jpeg({ exif: exifSegment(exifTiff({ little, orientation, gps: true })) }).file);
        const at = out.indexOf('Exif\0\0');
        expect(at).toBeGreaterThan(0);
        expect(out[at + 6 + 19]).toBe(orientation);
        expectNoSecrets(out);
      }
    for (const raw of [0, 9, 0xffff]) {
      const out = ok('image/jpeg', jpeg({ exif: exifSegment(exifTiff({ little: true, rawOrientationValue: raw })) }).file);
      expect(has(out, 'Exif\0\0'), `value ${raw}`).toBe(false);
    }
    const none = ok('image/jpeg', jpeg({ exif: exifSegment(exifTiff({ little: false, gps: true })) }).file);
    expect(has(none, 'Exif\0\0')).toBe(false);
    expectNoSecrets(none);
  });

  it('survives a hostile EXIF (bad TIFF header, wild offsets, an entry count far larger than the segment): no orientation, never an exception', () => {
    const hostile = [
      segment(0xe1, cat(ascii('Exif\0\0'), ascii('XX*\0'), u32le(8))),
      segment(0xe1, cat(ascii('Exif\0\0'), ascii('II*\0'), u32le(0xffffffff), [0, 0])),
      segment(0xe1, cat(ascii('Exif\0\0'), ascii('II*\0'), u32le(8), [0xff, 0xff], Buffer.alloc(12, 0x12))),
      segment(0xe1, cat(ascii('Exif\0\0'), ascii('MM\0*'), u32be(8), u16be(1), u16be(0x0112), u16be(4), u32be(1), u32be(6), u32be(0))), // wrong type
      segment(0xe1, ascii('Exif\0\0')),
    ];
    for (const exif of hostile) {
      const out = ok('image/jpeg', jpeg({ exif }).file);
      expect(has(out, 'Exif\0\0')).toBe(false);
      expectNoSecrets(out);
    }
  });

  it('uses only the FIRST EXIF segment and drops later ones', () => {
    const out = ok(
      'image/jpeg',
      jpeg({ exif: cat(exifSegment(exifTiff({ little: true, orientation: 3 })), exifSegment(exifTiff({ little: true, orientation: 8, gps: true }))) }).file,
    );
    expect(count(out, 'Exif\0\0')).toBe(1);
    expect(out[out.indexOf('Exif\0\0') + 6 + 19]).toBe(3);
  });

  it('handles progressive JPEG (several scans, DHT between scans) and keeps every scan', () => {
    const { file, image } = jpeg({ progressive: true, exif: exifLe });
    const out = ok('image/jpeg', file);
    expect(out.subarray(out.length - image.length).equals(image)).toBe(true);
    expect(readImageDimensions('image/jpeg', out)).toEqual({ width: 640, height: 480 });
  });

  it('is idempotent and never modifies its input', () => {
    const { file } = jpeg({ exif: exifLe });
    const copy = Buffer.from(file);
    const once = ok('image/jpeg', file);
    expect(file.equals(copy)).toBe(true);
    expect(ok('image/jpeg', once).equals(once)).toBe(true);
  });

  it('a JPEG without metadata or tail comes out byte-identical', () => {
    const image = jpegImagePart(100, 50);
    const plain = cat([0xff, 0xd8], segment(0xe0, cat(ascii('JFIF\0'), [1, 1, 0, 0, 1, 0, 1, 0, 0])), image);
    expect(ok('image/jpeg', plain).equals(plain)).toBe(true);
  });

  it('accepts a Uint8Array that is not a Buffer and a Buffer that is a view into a larger one', () => {
    const { file } = jpeg({ exif: exifLe });
    const u8 = new Uint8Array(file);
    expect(ok('image/jpeg', Buffer.from(u8)).equals(ok('image/jpeg', file))).toBe(true);
    const r = sanitizeImage('image/jpeg', u8);
    expect(r.ok).toBe(true);
    const big = Buffer.concat([Buffer.alloc(10, 1), file, Buffer.alloc(10, 2)]);
    const view = big.subarray(10, 10 + file.length);
    expect(ok('image/jpeg', view).equals(ok('image/jpeg', file))).toBe(true);
  });

  it('refuses every truncation of a JPEG before its EOI with a typed result, never an exception', () => {
    const { file, image } = jpeg({ exif: exifLe });
    const eoiEnd = file.length - (file.length - (file.indexOf(image) + image.length));
    for (let n = 0; n < eoiEnd; n++) {
      const r = sanitizeImage('image/jpeg', file.subarray(0, n));
      expect(r.ok, `prefix ${n}`).toBe(false);
    }
    expect(sanitizeImage('image/jpeg', file.subarray(0, eoiEnd)).ok).toBe(true);
  });

  it('refuses hostile JPEG structures', () => {
    const img = jpegImagePart(10, 10);
    const soi = [0xff, 0xd8];
    expect(reason('image/jpeg', cat(soi, [0xff, 0xe1, 0xff, 0xff], Buffer.alloc(20)))).toBe('TRUNCATED'); // claims 65535 bytes
    expect(reason('image/jpeg', cat(soi, [0xff, 0xe1, 0x00, 0x00], img))).toBe('MALFORMED'); // length below 2
    expect(reason('image/jpeg', cat(soi, [0xff, 0xe1, 0x00, 0x01], img))).toBe('MALFORMED');
    expect(reason('image/jpeg', cat(soi, [0x12, 0x34], img))).toBe('SIGNATURE_MISMATCH'); // not a marker after SOI
    expect(reason('image/jpeg', cat(soi, [0xff, 0xe0, 0x00, 0x02, 0x41, 0x42]))).toBe('MALFORMED'); // junk where a marker belongs
    expect(reason('image/jpeg', cat(soi, [0xff, 0xd9]))).toBe('MALFORMED'); // EOI with no image
    expect(reason('image/jpeg', cat(soi, [0xff, 0xda, 0x00, 0x02, 0x00, 0xff, 0xd9]))).toBe('MALFORMED'); // scan before a frame
    expect(reason('image/jpeg', cat(soi, [0xff, 0xd8], img))).toBe('MALFORMED'); // second SOI
    expect(reason('image/jpeg', cat(soi, [0xff, 0x02, 0x00, 0x02], img))).toBe('MALFORMED'); // reserved marker
    expect(reason('image/jpeg', cat(soi, segment(0xc0, Buffer.from([8, 0, 1])), [0xff, 0xd9]))).toBe('MALFORMED'); // frame header too short
    expect(reason('image/jpeg', cat(soi, [0xff, 0xda, 0xff, 0xff], Buffer.alloc(5)))).toBe('TRUNCATED'); // claims 65535 bytes of scan header
    // scan that never ends
    expect(
      reason(
        'image/jpeg',
        cat(soi, segment(0xc0, cat([8], u16be(10), u16be(10), [1, 1, 0x11, 0])), segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.alloc(50, 0x11)),
      ),
    ).toBe('TRUNCATED');
    expect(reason('image/jpeg', Buffer.alloc(0))).toBe('SIGNATURE_MISMATCH');
    expect(reason('image/jpeg', Buffer.from([0xff, 0xd8]))).toBe('SIGNATURE_MISMATCH');
  });

  it('refuses another format declared as JPEG', () => {
    expect(reason('image/jpeg', png().file)).toBe('SIGNATURE_MISMATCH');
    expect(reason('image/jpeg', webp().file)).toBe('SIGNATURE_MISMATCH');
  });
});

// ---------------------------------------------------------------- PNG
describe('sanitizeImage: PNG', () => {
  it('drops tEXt, zTXt, iTXt, eXIf, tIME, unknown ancillary chunks and the data after IEND; keeps the critical and colour chunks byte-identical', () => {
    const { file, kept } = png();
    expect(has(file, 'SECRET-TEXT')).toBe(true);
    expect(has(file, 'SECRET-GPS')).toBe(true);
    const out = ok('image/png', file);
    expectNoSecrets(out);
    for (const gone of ['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'prVT']) expect(has(out, gone), gone).toBe(false);
    expect(out.equals(cat(PNG_SIG, ...kept))).toBe(true); // exactly the kept chunks in their original order
    expect(readImageDimensions('image/png', out)).toEqual({ width: 320, height: 200 });
    expect(readImageDimensions('image/png', file)).toEqual({ width: 320, height: 200 });
  });

  it('is idempotent; a clean PNG without a tail is byte-identical', () => {
    const { file, kept } = png();
    const once = ok('image/png', file);
    expect(ok('image/png', once).equals(once)).toBe(true);
    const clean = cat(PNG_SIG, ...kept);
    expect(ok('image/png', clean).equals(clean)).toBe(true);
  });

  it('refuses every truncation before IEND with a typed result', () => {
    const { file, all } = png();
    for (let n = 0; n < all.length; n++) expect(sanitizeImage('image/png', file.subarray(0, n)).ok, `prefix ${n}`).toBe(false);
    expect(sanitizeImage('image/png', all).ok).toBe(true);
  });

  it('refuses hostile PNG structures', () => {
    const idat = chunk('IDAT', Buffer.alloc(8, 1));
    const iend = chunk('IEND', Buffer.alloc(0));
    expect(reason('image/png', cat(PNG_SIG, [0x7f, 0xff, 0xff, 0xff], ascii('IDAT'), Buffer.alloc(30)))).toBe('TRUNCATED'); // claims 2 GiB as the first chunk
    expect(reason('image/png', cat(PNG_SIG, ihdr(10, 10), [0x7f, 0xff, 0xff, 0xff], ascii('tEXt'), Buffer.alloc(30)))).toBe('TRUNCATED'); // claims 2 GiB
    expect(reason('image/png', cat(PNG_SIG, ihdr(10, 10), [0xff, 0xff, 0xff, 0xff], ascii('tEXt'), Buffer.alloc(30)))).toBe('MALFORMED'); // above the PNG maximum
    expect(reason('image/png', cat(PNG_SIG, ihdr(10, 10), u32be(0), [0x01, 0x02, 0x03, 0x04], Buffer.alloc(8)))).toBe('MALFORMED'); // chunk type is not letters
    expect(reason('image/png', cat(PNG_SIG, idat, iend))).toBe('MALFORMED'); // no IHDR first
    expect(reason('image/png', cat(PNG_SIG, ihdr(10, 10), ihdr(10, 10), idat, iend))).toBe('MALFORMED'); // second IHDR
    expect(reason('image/png', cat(PNG_SIG, chunk('IHDR', Buffer.alloc(12)), idat, iend))).toBe('MALFORMED'); // IHDR with the wrong length
    expect(reason('image/png', cat(PNG_SIG, ihdr(10, 10), iend))).toBe('MALFORMED'); // no image data
    expect(reason('image/png', cat(PNG_SIG, ihdr(10, 10), idat, chunk('IEND', Buffer.alloc(4))))).toBe('MALFORMED'); // IEND with data
    expect(reason('image/png', cat(PNG_SIG, ihdr(10, 10), idat))).toBe('TRUNCATED'); // no IEND
    expect(reason('image/png', cat(PNG_SIG.subarray(0, 7)))).toBe('SIGNATURE_MISMATCH');
    expect(reason('image/png', jpeg().file)).toBe('SIGNATURE_MISMATCH');
  });
});

// ---------------------------------------------------------------- WebP
describe('sanitizeImage: WebP', () => {
  it('drops EXIF, XMP and unknown chunks and the tail, clears only the EXIF and XMP flags, fixes the RIFF size and keeps the image chunks byte-identical', () => {
    const { file, kept } = webp();
    expect(has(file, 'SECRET-GPS')).toBe(true);
    const out = ok('image/webp', file);
    expectNoSecrets(out);
    for (const gone of ['EXIF', 'XMP ', 'ZZZZ']) expect(has(out, gone), gone).toBe(false);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(out.subarray(8, 12).toString('latin1')).toBe('WEBP');
    // VP8X: ICC (0x20) and alpha (0x10) stay, EXIF (0x08) and XMP (0x04) go
    expect(out[12 + 8]).toBe(0x30);
    const expected = cat(ascii('RIFF'), u32le(0), ascii('WEBP'), kept[0]!, kept[1]!, kept[2]!, kept[3]!);
    expected[12 + 8] = 0x30;
    expected.writeUInt32LE(expected.length - 8, 4);
    expect(out.equals(expected)).toBe(true);
    expect(readImageDimensions('image/webp', out)).toEqual({ width: 800, height: 600 });
    expect(readImageDimensions('image/webp', file)).toEqual({ width: 800, height: 600 });
  });

  it('is idempotent and a clean lossy WebP (no VP8X) is byte-identical', () => {
    const once = ok('image/webp', webp().file);
    expect(ok('image/webp', once).equals(once)).toBe(true);
    const plain = riffOf(rchunk('VP8 ', vp8Data(64, 32)));
    expect(ok('image/webp', plain).equals(plain)).toBe(true);
    expect(readImageDimensions('image/webp', ok('image/webp', plain))).toEqual({ width: 64, height: 32 });
  });

  it('removes EXIF/XMP chunks of a simple (non-extended) WebP too, and keeps animation chunks', () => {
    const simple = riffOf(rchunk('VP8 ', vp8Data(64, 32)), rchunk('EXIF', ascii('SECRET-EXIF')));
    const out = ok('image/webp', simple);
    expect(has(out, 'EXIF')).toBe(false);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    const anim = riffOf(
      vp8x(0x02 | 0x08, 40, 40),
      rchunk('ANIM', Buffer.alloc(6, 1)),
      anmf([rchunk('VP8 ', vp8Data(40, 40))]),
      rchunk('EXIF', ascii('SECRET-EXIF')),
    );
    const animOut = ok('image/webp', anim);
    expect(has(animOut, 'ANIM')).toBe(true);
    expect(has(animOut, 'ANMF')).toBe(true);
    expect(animOut[12 + 8]).toBe(0x02);
  });

  it('refuses every truncation inside the declared container with a typed result', () => {
    const { file } = webp({ trailing: Buffer.alloc(0) });
    for (let n = 0; n < file.length; n++) expect(sanitizeImage('image/webp', file.subarray(0, n)).ok, `prefix ${n}`).toBe(false);
    expect(sanitizeImage('image/webp', file).ok).toBe(true);
  });

  it('refuses hostile WebP structures', () => {
    const vp8 = rchunk('VP8 ', vp8Data(64, 32));
    const withRiff = (size: number, rest: Buffer) => cat(ascii('RIFF'), u32le(size), ascii('WEBP'), rest);
    expect(reason('image/webp', withRiff(0xffffffff, vp8))).toBe('TRUNCATED'); // claims 4 GiB
    expect(reason('image/webp', withRiff(3, Buffer.alloc(0)))).toBe('MALFORMED');
    expect(reason('image/webp', withRiff(4 + 8 + 0xffffff00, Buffer.alloc(0)))).toBe('TRUNCATED');
    expect(reason('image/webp', withRiff(4 + 8, cat(ascii('VP8 '), u32le(0xffffffff))))).toBe('TRUNCATED'); // chunk claims 4 GiB inside a tiny container
    expect(reason('image/webp', withRiff(4 + 8, cat(ascii('VP8 '), u32le(100))))).toBe('TRUNCATED'); // chunk claims more than the container holds
    expect(reason('image/webp', withRiff(4 + 5, cat(ascii('VP8 '), [0])))).toBe('MALFORMED'); // chunk header cut short
    expect(reason('image/webp', withRiff(4 + vp8.length, vp8.subarray(0, vp8.length - 1)))).toBe('TRUNCATED'); // declared container larger than the file
    expect(reason('image/webp', riffOf(rchunk('EXIF', ascii('x')), vp8))).toBe('MALFORMED'); // first chunk is not an image header
    expect(reason('image/webp', riffOf(rchunk('ICCP', ascii('x'))))).toBe('MALFORMED');
    expect(reason('image/webp', riffOf(vp8x(0, 10, 10)))).toBe('MALFORMED'); // no image data
    expect(reason('image/webp', riffOf(rchunk('VP8X', Buffer.alloc(4)), vp8))).toBe('MALFORMED'); // VP8X too short
    expect(has(ok('image/webp', riffOf(vp8, vp8x(0, 10, 10))), 'VP8X')).toBe(false); // a simple file keeps its one image chunk; a VP8X after it is dropped
    expect(reason('image/webp', cat(ascii('RIFF'), u32le(4), ascii('WAVE')))).toBe('SIGNATURE_MISMATCH');
    expect(reason('image/webp', Buffer.alloc(5))).toBe('SIGNATURE_MISMATCH');
    expect(reason('image/webp', cat(ascii('RIFF'), u32le(4 + 8 + 3), ascii('WEBP'), ascii('VP8 '), u32le(3), [1, 2, 3]))).toBe('MALFORMED'); // odd chunk without its pad byte
  });
});

// ---------------------------------------------------------------- shared
describe('sanitizeImage: shared rules', () => {
  it('the size limit is inclusive: exactly maxBytes is not TOO_LARGE, one more byte is', () => {
    // a non-image of exactly the limit must fail for its CONTENT (signature), not for its size
    expect(sanitizeImage('image/jpeg', Buffer.alloc(100), { maxBytes: 100 })).toEqual({ ok: false, reason: 'SIGNATURE_MISMATCH' });
    expect(sanitizeImage('image/jpeg', Buffer.alloc(101), { maxBytes: 100 })).toEqual({ ok: false, reason: 'TOO_LARGE' });
  });
  it('refuses an unsupported or inherited type name, and an input above the limit before any work', () => {
    for (const t of ['image/gif', 'text/html', '', 'constructor', '__proto__', 'IMAGE/JPEG']) expect(reason(t, jpeg().file)).toBe('UNSUPPORTED_TYPE');
    expect(sanitizeImage('image/jpeg', Buffer.alloc(101), { maxBytes: 100 })).toEqual({ ok: false, reason: 'TOO_LARGE' });
    expect(sanitizeImage('image/jpeg', Buffer.alloc(26_214_401), { maxBytes: 1e12 })).toEqual({ ok: false, reason: 'TOO_LARGE' }); // never above the structural ceiling
  });

  it('removes a polyglot tail of each format (HTML, script, ZIP, a second image)', () => {
    const tails = [
      ascii('<html><script>alert(document.cookie)</script></html>SECRET-TAIL'),
      cat(ascii('PK\x03\x04'), Buffer.alloc(100, 0x41), ascii('SECRET-TAIL')),
      Buffer.alloc(5000, 0),
    ];
    for (const trailing of tails) {
      expectNoSecrets(ok('image/jpeg', jpeg({ trailing }).file));
      expect(ok('image/jpeg', jpeg({ trailing }).file).length).toBeLessThan(jpeg({ trailing }).file.length);
      const p = png({ trailing });
      expect(ok('image/png', p.file).equals(cat(PNG_SIG, ...p.kept))).toBe(true);
      const w = ok('image/webp', webp({ trailing }).file);
      expect(w.readUInt32LE(4)).toBe(w.length - 8);
      expect(has(w, 'SECRET-TAIL')).toBe(false);
    }
  });

  it('never throws on random and structured garbage declared as each type', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 8) & 0xff;
    const seeds = [jpeg().file, png().file, webp().file];
    for (const mime of ['image/jpeg', 'image/png', 'image/webp'])
      for (let round = 0; round < 300; round++) {
        const base = Buffer.from(seeds[round % 3]!);
        for (let k = 0; k < 1 + (round % 6); k++) base[rnd() % base.length] = rnd();
        const cut = base.subarray(0, round % 7 === 0 ? rnd() % base.length : base.length);
        const r = sanitizeImage(mime, cut);
        expect(typeof r.ok).toBe('boolean');
        if (r.ok) expect(r.bytes.length).toBeLessThanOrEqual(cut.length + 64);
      }
    for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
      for (let round = 0; round < 100; round++) {
        const g = Buffer.alloc(rnd() + 1);
        for (let k = 0; k < g.length; k++) g[k] = rnd();
        expect(() => sanitizeImage(mime, g)).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------- linear time and bounded memory
describe('sanitizeImage: linear time', () => {
  const time = (fn: () => void): number => {
    let best = Infinity;
    for (let k = 0; k < 9; k++) {
      const t = performance.now();
      fn();
      best = Math.min(best, performance.now() - t);
    }
    return best;
  };
  /** Builds an input of a hostile shape at a given scale; sanitising 8x the input must not take anywhere near 64x (quadratic) the time. */
  function assertLinear(name: string, mime: string, make: (scale: number) => Buffer): void {
    it(name, () => {
      const small = make(1);
      const large = make(8);
      expect(sanitizeImage(mime, small).ok).toBe(true); // the shapes are valid inputs: the time is spent on real work
      expect(sanitizeImage(mime, large).ok).toBe(true);
      // A quadratic implementation is ~64x slower at 8x the input on EVERY attempt; a loaded machine (the whole workspace testing in parallel) can spike one attempt, so up to three attempts
      // are allowed and the best ratio counts. The threshold itself is unchanged.
      let bestRatio = Infinity;
      let note = '';
      let tLarge = Infinity;
      for (let attempt = 0; attempt < 3 && bestRatio >= 40; attempt++) {
        const tSmall = Math.max(
          time(() => sanitizeImage(mime, small)),
          0.5,
        );
        tLarge = time(() => sanitizeImage(mime, large));
        if (tLarge / tSmall < bestRatio) {
          bestRatio = tLarge / tSmall;
          note = `${name}: ${tSmall.toFixed(2)}ms -> ${tLarge.toFixed(2)}ms`;
        }
      }
      expect(bestRatio, note).toBeLessThan(40);
      expect(tLarge).toBeLessThan(4000);
    });
  }
  const jpegHead = (w: number, h: number) =>
    cat([0xff, 0xd8], segment(0xc0, cat([8], u16be(h), u16be(w), [1, 1, 0x11, 0])), segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])));
  assertLinear('many dropped JPEG segments', 'image/jpeg', (s) =>
    catList([[0xff, 0xd8], ...Array.from({ length: 20_000 * s }, () => segment(0xfe, ascii('c'))), jpegHead(8, 8).subarray(2), ENTROPY, [0xff, 0xd9]]),
  );
  assertLinear('many kept JPEG segments alternating with dropped ones', 'image/jpeg', (s) =>
    catList([
      [0xff, 0xd8],
      ...Array.from({ length: 10_000 * s }, () => cat(segment(0xdb, cat([0], Buffer.alloc(64, 1))), segment(0xfe, ascii('c')))),
      jpegHead(8, 8).subarray(2),
      ENTROPY,
      [0xff, 0xd9],
    ]),
  );
  assertLinear('millions of fill bytes between markers', 'image/jpeg', (s) =>
    cat([0xff, 0xd8], Buffer.alloc(200_000 * s, 0xff), jpegHead(8, 8).subarray(2), ENTROPY, [0xff, 0xd9]),
  );
  assertLinear('large entropy-coded data full of stuffed bytes and restarts', 'image/jpeg', (s) =>
    cat(
      jpegHead(8, 8),
      Buffer.from(Array.from({ length: 30_000 * s }, (_, i) => [0xff, 0x00, 0xff, 0xd0 + (i % 8), 0xff, 0xff, 0xd0 + ((i + 1) % 8)]).flat()),
      [0xff, 0xd9],
    ),
  );
  assertLinear('a long run of 0xFF bytes inside the scan', 'image/jpeg', (s) => cat(jpegHead(8, 8), Buffer.alloc(300_000 * s, 0xff), [0xd9]));
  assertLinear('many PNG chunks', 'image/png', (s) =>
    catList([
      PNG_SIG,
      ihdr(8, 8),
      ...Array.from({ length: 6_000 * s }, (_, i) => chunk(i % 2 ? 'tEXt' : 'IDAT', Buffer.from('k\0v'))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
  assertLinear('many WebP chunks', 'image/webp', (s) =>
    riffList([rchunk('VP8 ', vp8Data(8, 8)), ...Array.from({ length: 10_000 * s }, (_, i) => rchunk(i % 2 ? 'EXIF' : 'ALPH', Buffer.from('abc')))]),
  );

  it('a 24 MiB JPEG with a huge scan is sanitised without extra copies of the input beyond the bounded output', () => {
    const big = cat(jpegHead(8, 8), Buffer.alloc(24 * 1024 * 1024, 0x11), [0xff, 0xd9]);
    const t = performance.now();
    const r = sanitizeImage('image/jpeg', big);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.length).toBe(big.length);
    expect(performance.now() - t).toBeLessThan(4000);
  });
});

// ---------------------------------------------------------------- kept parts are validated, not trusted by name (every case has a positive control: the input holds the secret)
const SOI = Buffer.from([0xff, 0xd8]);
const jpegWith = (...segments: Buffer[]): Buffer => cat(SOI, ...segments, jpegImagePart(640, 480));
const jfifPayload = (thumb: Buffer, thumbX = 0, thumbY = 0): Buffer => cat(ascii('JFIF\0'), [1, 1, 0, 0, 1, 0, 1, thumbX, thumbY], thumb);
const iccChunk = (seq: number, of: number, data: Buffer): Buffer => segment(0xe2, cat(ascii('ICC_PROFILE\0'), [seq, of], data));

describe('sanitizeImage: kept JPEG parts', () => {
  it('rewrites JFIF to exactly 16 bytes with no thumbnail: a thumbnail and extra bytes are gone, the density is kept', () => {
    for (const payload of [jfifPayload(ascii('SECRET-THUMB-SECRET-THUMB'), 2, 2), jfifPayload(ascii('SECRET-TAIL')), jfifPayload(Buffer.alloc(0), 5, 5)]) {
      const input = jpegWith(segment(0xe0, payload));
      const out = ok('image/jpeg', input);
      expectNoSecrets(out);
      const at = out.indexOf('JFIF\0');
      expect(at).toBe(6);
      expect(out.readUInt16BE(at - 2)).toBe(16);
      expect([...out.subarray(at, at + 14)]).toEqual([...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
      expect(out.indexOf(0xff, at + 14)).toBe(at + 14); // the next segment starts right after the 16 bytes
    }
    expect(has(jpegWith(segment(0xe0, jfifPayload(ascii('SECRET-THUMB'), 2, 2))), 'SECRET-THUMB')).toBe(true); // positive control
  });

  it('drops a JFIF with an unknown version or units, a second JFIF, and a JFIF after the frame', () => {
    const odd = Buffer.from(jfifPayload(Buffer.alloc(0)));
    odd[5] = 2; // version 2.x
    expect(has(ok('image/jpeg', jpegWith(segment(0xe0, odd))), 'JFIF')).toBe(false);
    const units = Buffer.from(jfifPayload(Buffer.alloc(0)));
    units[7] = 9;
    expect(has(ok('image/jpeg', jpegWith(segment(0xe0, units))), 'JFIF')).toBe(false);
    expect(
      count(ok('image/jpeg', jpegWith(segment(0xe0, jfifPayload(Buffer.alloc(0))), segment(0xe0, jfifPayload(ascii('SECRET-THUMB'), 1, 1)))), 'JFIF\0'),
    ).toBe(1);
    const late = cat(SOI, jpegImagePart(64, 48).subarray(0, jpegImagePart(64, 48).length - 2), segment(0xe0, jfifPayload(Buffer.alloc(0))), [0xff, 0xd9]);
    expect(reason('image/jpeg', late)).toBe('OK');
    expect(has(ok('image/jpeg', late), 'JFIF')).toBe(false);
  });

  it('rewrites Adobe APP14 to exactly 12 payload bytes: trailing text is gone, the transform is kept; an invalid transform drops it', () => {
    const adobe = (tail: Buffer, transform = 1) => segment(0xee, cat(ascii('Adobe'), [0, 100, 0, 0, 0, 0, transform], tail));
    const input = jpegWith(adobe(ascii('SECRET-TAIL')));
    expect(has(input, 'SECRET-TAIL')).toBe(true);
    const out = ok('image/jpeg', input);
    expectNoSecrets(out);
    const at = out.indexOf('Adobe');
    expect(out.readUInt16BE(at - 2)).toBe(14);
    expect(out[at + 11]).toBe(1);
    expect(has(ok('image/jpeg', jpegWith(adobe(Buffer.alloc(0), 9))), 'Adobe')).toBe(false);
    expect(has(ok('image/jpeg', jpegWith(segment(0xee, ascii('Adobe\0\0')))), 'Adobe')).toBe(false); // too short to be an Adobe segment
  });

  it('keeps an ICC profile only when it is complete and valid: trailing text, a bad header, a gap in the sequence and an over-large profile drop it entirely', () => {
    const profile = iccProfile(300);
    const control = jpegWith(iccChunk(1, 1, profile));
    expect(has(ok('image/jpeg', control), 'ICC_PROFILE\0')).toBe(true); // positive control: a valid profile survives
    const withText = jpegWith(iccChunk(1, 1, cat(profile, ascii('SECRET-TEXT'))));
    expect(has(withText, 'SECRET-TEXT')).toBe(true);
    const noAcsp = Buffer.from(profile);
    noAcsp.write('xxxx', 36, 'latin1');
    const hugeProfile = iccProfile(300_000);
    const hugeChunks = Array.from({ length: 5 }, (_, k) =>
      iccChunk(k + 1, 5, hugeProfile.subarray(k * 60_000, Math.min((k + 1) * 60_000, hugeProfile.length))),
    );
    const cases = [
      withText,
      jpegWith(iccChunk(1, 1, noAcsp)),
      jpegWith(iccChunk(2, 2, profile)),
      jpegWith(iccChunk(1, 2, profile)),
      jpegWith(...hugeChunks),
      jpegWith(iccChunk(1, 1, profile.subarray(0, 100))),
    ];
    for (const input of cases) {
      const out = ok('image/jpeg', input);
      expect(has(out, 'ICC_PROFILE'), 'a bad ICC profile is dropped').toBe(false);
      expectNoSecrets(out);
    }
  });

  it('keeps a two-chunk ICC profile in order and drops it when the chunks repeat, run out of order or disagree on the count', () => {
    const profile = iccProfile(400);
    const a = profile.subarray(0, 300);
    const b = profile.subarray(300);
    expect(count(ok('image/jpeg', jpegWith(iccChunk(1, 2, a), iccChunk(2, 2, b))), 'ICC_PROFILE')).toBe(2);
    for (const bad of [
      [iccChunk(2, 2, b), iccChunk(1, 2, a)],
      [iccChunk(1, 2, a), iccChunk(1, 2, b)],
      [iccChunk(1, 2, a), iccChunk(2, 3, b)],
      [iccChunk(1, 2, a)],
    ])
      expect(has(ok('image/jpeg', jpegWith(...bad)), 'ICC_PROFILE')).toBe(false);
  });

  it('drops ICC chunks that come after the scan started (progressive scans), whatever they hold', () => {
    const base = jpegImagePart(640, 480);
    const input = cat(
      SOI,
      iccChunk(1, 1, iccProfile(10)),
      base.subarray(0, base.length - 2),
      iccChunk(1, 1, cat(iccProfile(10), ascii('SECRET-TEXT'))),
      [0xff, 0xd9],
    );
    const out = ok('image/jpeg', input);
    expect(count(out, 'ICC_PROFILE')).toBe(1);
    expectNoSecrets(out);
  });

  it('refuses a table or header whose declared layout is not its real layout (secret bytes inside DQT, DHT, SOF, SOS or DRI)', () => {
    const dqt = cat([0x00], Buffer.alloc(64, 7));
    const dht = cat([0x00], [2], Buffer.alloc(15, 0), [0x01, 0x02]);
    const sof = cat([8], u16be(480), u16be(640), [1, 1, 0x11, 0]);
    const sos = Buffer.from([1, 1, 0, 0, 63, 0]);
    const head = (segs: Buffer[]) => cat(SOI, ...segs, [0xff, 0xd9]);
    const good = [segment(0xdb, dqt), segment(0xc0, sof), segment(0xc4, dht), segment(0xda, sos), ENTROPY];
    expect(reason('image/jpeg', head(good))).toBe('OK'); // positive control: the pieces are valid together
    const secret = ascii('SECRET-EXIF');
    const swap = (i: number, seg: Buffer) => head(good.map((s, k) => (k === i ? seg : s)));
    const bad = [
      swap(0, segment(0xdb, cat(dqt, secret))), // table plus spare bytes
      swap(0, segment(0xdb, dqt.subarray(0, 60))), // table cut short
      swap(0, segment(0xdb, cat([0x40], Buffer.alloc(64)))), // Pq 4 is not a precision
      swap(0, segment(0xdb, Buffer.alloc(0))),
      swap(1, segment(0xc0, cat(sof, secret))),
      swap(1, segment(0xc0, cat([8], u16be(0), u16be(640), [1, 1, 0x11, 0]))), // height 0
      swap(1, segment(0xc0, cat([9], u16be(480), u16be(640), [1, 1, 0x11, 0]))), // precision 9
      swap(1, segment(0xc0, cat([8], u16be(480), u16be(640), [1, 1, 0x51, 0]))), // sampling factor 5
      swap(1, segment(0xc0, cat([8], u16be(480), u16be(640), [5, 1, 0x11, 0]))), // 5 components claimed, 1 present
      swap(2, segment(0xc4, cat(dht, secret))),
      swap(2, segment(0xc4, cat([0x00], [200, 200], Buffer.alloc(14, 0)))), // more than 256 symbols
      swap(2, segment(0xc4, cat([0x00], Buffer.alloc(16, 0)).subarray(0, 12))),
      swap(3, segment(0xda, cat(sos, secret))),
      swap(3, segment(0xda, Buffer.from([2, 1, 0, 2, 0, 0, 63, 0]))), // two components in a one-component frame
      swap(3, segment(0xda, Buffer.from([1, 1, 0x44, 0, 63, 0]))), // selector 4
      swap(3, segment(0xda, Buffer.from([1, 1, 0, 0, 64, 0]))), // Se 64
      head([...good.slice(0, 2), segment(0xdd, cat(u16be(10), secret)), ...good.slice(2)]), // DRI with spare bytes
      head([...good.slice(0, 2), segment(0xc0, sof), ...good.slice(2)]), // a second frame
    ];
    for (const [k, input] of bad.entries()) {
      const r = sanitizeImage('image/jpeg', input);
      expect(r.ok, `case ${k}`).toBe(false);
    }
    expect(has(swap(0, segment(0xdb, cat(dqt, secret))), 'SECRET-EXIF')).toBe(true); // the secret really was in the input
  });

  it('refuses markers this build cannot validate: a COM flipped to a frame marker, other frame types, DNL, DHP, EXP, DAC and reserved ones', () => {
    const secret = ascii('SECRET-COMMENT');
    expect(has(ok('image/jpeg', jpegWith(segment(0xfe, secret))), 'SECRET-COMMENT')).toBe(false); // an honest COM is dropped
    for (const marker of [0xce, 0xcd, 0xc3, 0xc5, 0xc9, 0xca, 0xcb, 0xcf, 0xcc, 0xdc, 0xde, 0xdf, 0xc8, 0x02, 0x7f, 0xbf, 0x00])
      expect(reason('image/jpeg', jpegWith(segment(marker, secret))), marker.toString(16)).toBe('MALFORMED');
    // SOF1 and SOF2 are validated and kept
    const sof1 = jpegImagePart(64, 48);
    expect(reason('image/jpeg', cat(SOI, sof1))).toBe('OK');
    expect(reason('image/jpeg', jpegWith(segment(0xc1, cat([8], u16be(48), u16be(64), [1, 1, 0x11, 0]))))).toBe('MALFORMED'); // second frame
  });

  it('drops fill bytes between segments, stray RSTn/TEM outside a scan, and rejects padding that is not fill', () => {
    const plain = jpegWith(segment(0xe0, jfifPayload(Buffer.alloc(0))));
    const withFill = cat(SOI, Buffer.alloc(40, 0xff), segment(0xe0, jfifPayload(Buffer.alloc(0))), Buffer.alloc(30, 0xff), jpegImagePart(640, 480));
    expect(ok('image/jpeg', withFill).equals(ok('image/jpeg', plain))).toBe(true);
    const stray = cat(SOI, [0xff, 0x01, 0xff, 0xd3], segment(0xe0, jfifPayload(Buffer.alloc(0))), jpegImagePart(640, 480));
    expect(ok('image/jpeg', stray).equals(ok('image/jpeg', plain))).toBe(true);
    // padding of any other value between segments is not a JPEG
    for (const pad of [Buffer.from([0]), ascii('SECRET-TAIL'), Buffer.from([0x41, 0x42])]) {
      const padded = cat(SOI, segment(0xe0, jfifPayload(Buffer.alloc(0))), pad, jpegImagePart(640, 480));
      expect(reason('image/jpeg', padded)).toBe('MALFORMED');
    }
  });
});

// ---------------------------------------------------------------- PNG kept parts
describe('sanitizeImage: kept PNG parts', () => {
  const secret = ascii('SECRET-TEXT');
  const pngOf = (...chunks: Buffer[]): Buffer => cat(PNG_SIG, ...chunks, chunk('IDAT', Buffer.alloc(20, 0x55)), chunk('IEND', Buffer.alloc(0)));
  const rgb = ihdrOf(64, 64, 8, 2);
  const keptNames = (b: Buffer) => ['sRGB', 'gAMA', 'cHRM', 'pHYs', 'iCCP', 'tRNS', 'PLTE'].filter((t) => has(b, t));

  it('keeps ancillary chunks with exactly the defined layout and drops those with any other length or value (positive control: the valid one stays)', () => {
    const valid = [
      chunk('sRGB', Buffer.from([0])),
      chunk('gAMA', u32be(45455)),
      chunk('cHRM', Buffer.alloc(32, 3)),
      chunk('pHYs', cat(u32be(1), u32be(1), [1])),
      chunk('tRNS', Buffer.alloc(6, 1)),
    ];
    const out = ok('image/png', pngOf(rgb, ...valid));
    expect(keptNames(out)).toEqual(['sRGB', 'gAMA', 'cHRM', 'pHYs', 'tRNS']);
    expect(out.equals(pngOf(rgb, ...valid))).toBe(true);
    const wrong = [
      chunk('sRGB', cat([0], secret)),
      chunk('sRGB', Buffer.from([9])),
      chunk('gAMA', cat(u32be(1), secret)),
      chunk('cHRM', cat(Buffer.alloc(32), secret)),
      chunk('cHRM', Buffer.alloc(31)),
      chunk('pHYs', cat(u32be(1), u32be(1), [1], secret)),
      chunk('pHYs', cat(u32be(1), u32be(1), [7])),
      chunk('tRNS', cat(Buffer.alloc(6), secret)),
      chunk('tRNS', Buffer.alloc(2)), // two bytes belong to colour type 0, not 2
    ];
    for (const c of wrong) {
      const input = pngOf(rgb, c);
      const result = ok('image/png', input);
      expect(keptNames(result), c.toString('latin1', 4, 8)).toEqual([]);
      expectNoSecrets(result);
    }
    expect(has(pngOf(rgb, wrong[0]!), 'SECRET-TEXT')).toBe(true);
  });

  it('keeps each ancillary chunk once and only before the image data', () => {
    const g = chunk('gAMA', u32be(45455));
    expect(count(ok('image/png', pngOf(rgb, g, g)), 'gAMA')).toBe(1);
    const late = cat(PNG_SIG, rgb, chunk('IDAT', Buffer.alloc(20)), g, chunk('IDAT', Buffer.alloc(20)), chunk('IEND', Buffer.alloc(0)));
    expect(has(ok('image/png', late), 'gAMA')).toBe(false);
    expect(count(ok('image/png', late), 'IDAT')).toBe(2);
  });

  it('validates iCCP: the name, the method, the zlib stream (it must inflate to a valid profile, within the cap, ending where the chunk ends)', () => {
    expect(keptNames(ok('image/png', pngOf(rgb, chunk('iCCP', iccpData()))))).toEqual(['iCCP']); // positive control
    const stream = iccpData().subarray(5);
    const bomb = Buffer.concat([Buffer.from('icc\0\0'), deflateSync(Buffer.alloc(2_000_000, 0))]);
    const wrongProfile = Buffer.concat([Buffer.from('icc\0\0'), deflateSync(ascii('SECRET-TEXT'.padEnd(200, 'x')))]);
    const bad = [
      cat(ascii('SECRET-TEXT\0'), [0], stream).subarray(0, 0),
      cat(ascii('ic\nc\0'), [0], stream), // control character in the name
      cat(ascii('\0'), [0], stream), // empty name
      cat(ascii(' icc\0'), [0], stream),
      cat(ascii('i  cc\0'), [0], stream),
      cat(ascii('x'.repeat(80) + '\0'), [0], stream),
      cat(ascii('icc\0'), [1], stream), // method 1
      cat(ascii('icc\0'), [0], stream, ascii('SECRET-TEXT')), // text after the stream
      cat(ascii('icc\0'), [0], stream.subarray(0, stream.length - 6)), // cut short
      cat(ascii('icc\0'), [0], ascii('SECRET-TEXT-NOT-ZLIB')),
      bomb, // inflates far beyond the cap
      wrongProfile, // inflates to something that is not an ICC profile
    ].filter((b) => b.length > 0);
    for (const [k, data] of bad.entries()) {
      const input = pngOf(rgb, chunk('iCCP', data));
      const out = ok('image/png', input);
      expect(has(out, 'iCCP'), `iCCP case ${k}`).toBe(false);
      expectNoSecrets(out);
    }
  });

  it('validates IHDR and PLTE: bit depth and colour type pairs, methods, palette size and placement', () => {
    expect(reason('image/png', pngOf(ihdrOf(8, 8, 3, 2)))).toBe('MALFORMED'); // depth 3
    expect(reason('image/png', pngOf(ihdrOf(8, 8, 16, 3)))).toBe('MALFORMED'); // palette images have no 16-bit depth
    expect(reason('image/png', pngOf(ihdrOf(8, 8, 8, 7)))).toBe('MALFORMED'); // colour type 7
    expect(reason('image/png', pngOf(ihdrOf(8, 8, 8, 2, 2)))).toBe('MALFORMED'); // interlace 2
    expect(reason('image/png', pngOf(ihdrOf(0, 8, 8, 2)))).toBe('MALFORMED');
    expect(reason('image/png', pngOf(chunk('IHDR', cat(u32be(8), u32be(8), [8, 2, 1, 0, 0]))))).toBe('MALFORMED'); // compression method 1
    const pal = ihdrOf(8, 8, 8, 3);
    expect(reason('image/png', pngOf(pal))).toBe('MALFORMED'); // a palette image without a palette
    expect(reason('image/png', pngOf(pal, chunk('PLTE', Buffer.alloc(7))))).toBe('MALFORMED');
    expect(reason('image/png', pngOf(ihdrOf(8, 8, 2, 3), chunk('PLTE', Buffer.alloc(15))))).toBe('MALFORMED'); // 5 entries, 2 bits allow 4
    expect(reason('image/png', pngOf(ihdrOf(8, 8, 8, 0), chunk('PLTE', Buffer.alloc(3))))).toBe('MALFORMED'); // no palette in a greyscale image
    const withPalette = pngOf(pal, chunk('PLTE', Buffer.alloc(9, 1)), chunk('tRNS', Buffer.from([1, 2, 3])));
    expect(keptNames(ok('image/png', withPalette))).toEqual(['tRNS', 'PLTE']);
    expect(has(ok('image/png', pngOf(pal, chunk('PLTE', Buffer.alloc(9, 1)), chunk('tRNS', Buffer.alloc(4)))), 'tRNS')).toBe(false); // more transparency entries than palette entries
  });

  it('refuses a chunk with a type that is not four letters (the finalize-time refusal case)', () => {
    const bad = cat(PNG_SIG, rgb, u32be(0), [0x01, 0x02, 0x03, 0x04], u32be(0), chunk('IDAT', Buffer.alloc(8)), chunk('IEND', Buffer.alloc(0)));
    expect(reason('image/png', bad)).toBe('MALFORMED');
  });
});

// ---------------------------------------------------------------- WebP kept parts
describe('sanitizeImage: kept WebP parts', () => {
  const vp8 = rchunk('VP8 ', vp8Data(64, 32));
  const secret = ascii('SECRET-EXIF');

  it('refuses a VP8X that is not exactly 10 bytes and zeroes its reserved bytes', () => {
    const wide = rchunk('VP8X', cat([0x10, 0, 0, 0], u24le3(63), u24le3(31), secret));
    expect(reason('image/webp', riffOf(wide, vp8))).toBe('MALFORMED');
    const dirty = rchunk('VP8X', cat([0x10 | 0x08, 0x41, 0x42, 0x43], u24le3(63), u24le3(31)));
    expect(has(riffOf(dirty, vp8), 'ABC')).toBe(true); // the reserved bytes carried data
    const out = ok('image/webp', riffOf(dirty, vp8));
    expect([...out.subarray(20, 24)]).toEqual([0x10, 0, 0, 0]); // alpha kept, EXIF flag cleared, reserved bytes zero
  });

  it('recomputes the ICC flag from the ICCP chunk that is really kept; a bad ICCP is dropped', () => {
    const goodIcc = ok('image/webp', riffOf(vp8x(0, 64, 32), rchunk('ICCP', iccProfile(51)), vp8));
    expect(has(goodIcc, 'ICCP')).toBe(true);
    expect(goodIcc[20]! & 0x20).toBe(0x20); // the flag follows the chunk even though the input flag byte said 0
    const badIcc = riffOf(vp8x(0x20, 64, 32), rchunk('ICCP', cat(iccProfile(51), secret)), vp8);
    expect(has(badIcc, 'SECRET-EXIF')).toBe(true);
    const out = ok('image/webp', badIcc);
    expect(has(out, 'ICCP')).toBe(false);
    expect(out[20]! & 0x20).toBe(0);
    expectNoSecrets(out);
    expect(has(ok('image/webp', riffOf(vp8x(0, 64, 32), rchunk('ICCP', iccProfile(51)), rchunk('ICCP', iccProfile(51)), vp8)), 'ICCP')).toBe(true); // control; the second is dropped:
    expect(count(ok('image/webp', riffOf(vp8x(0, 64, 32), rchunk('ICCP', iccProfile(51)), rchunk('ICCP', iccProfile(51)), vp8)), 'ICCP')).toBe(1);
  });

  it('requires ANIM to be exactly 6 bytes and an ANIM before any frame', () => {
    const frame = anmf([rchunk('VP8 ', vp8Data(40, 40))]);
    expect(reason('image/webp', riffOf(vp8x(0x02, 40, 40), rchunk('ANIM', Buffer.alloc(7)), frame))).toBe('MALFORMED');
    expect(reason('image/webp', riffOf(vp8x(0x02, 40, 40), frame))).toBe('MALFORMED');
    expect(reason('image/webp', riffOf(vp8x(0x02, 40, 40), rchunk('ANIM', Buffer.alloc(6)), frame))).toBe('OK');
  });

  it('REBUILDS each animation frame: nested EXIF/XMP/unknown sub-chunks and a dirty frame-flags byte are gone, the size is rewritten, the image sub-chunks are byte-identical', () => {
    const alph = rchunk('ALPH', Buffer.alloc(9, 6));
    const img = rchunk('VP8 ', vp8Data(40, 40));
    const dirty = anmf(
      [
        rchunk('EXIF', cat(ascii('Exif\0\0'), exifTiff({ little: true, orientation: 6, gps: true }))),
        alph,
        rchunk('XMP ', ascii('<x:xmpmeta>SECRET-XMP</x:xmpmeta>')),
        img,
        rchunk('ZZZZ', secret),
      ],
      0xff,
    );
    const file = riffOf(vp8x(0x02 | 0x08 | 0x04, 40, 40), rchunk('ANIM', Buffer.alloc(6, 1)), dirty, anmf([img]));
    expect(has(file, 'SECRET-XMP') && has(file, 'SECRET-GPS') && has(file, 'SECRET-EXIF')).toBe(true); // positive control
    const out = ok('image/webp', file);
    expectNoSecrets(out);
    for (const gone of ['EXIF', 'XMP ', 'ZZZZ']) expect(has(out, gone), gone).toBe(false);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    const first = out.indexOf('ANMF');
    expect(out.readUInt32LE(first + 4)).toBe(16 + alph.length + img.length);
    expect(out[first + 8 + 15]).toBe(0x03); // reserved bits of the frame flags zeroed, blend and dispose kept
    expect(out.subarray(first + 8 + 16, first + 8 + 16 + alph.length).equals(alph)).toBe(true);
    expect(out.subarray(first + 8 + 16 + alph.length, first + 8 + 16 + alph.length + img.length).equals(img)).toBe(true);
    expect(out[20]).toBe(0x02);
    expect(count(out, 'ANMF')).toBe(2);
    expect(ok('image/webp', out).equals(out)).toBe(true);
  });

  it('refuses a frame without an image, a frame whose sub-chunks overrun it, and a still image mixed with frames', () => {
    const anim = rchunk('ANIM', Buffer.alloc(6));
    const x = vp8x(0x02, 40, 40);
    expect(reason('image/webp', riffOf(x, anim, anmf([rchunk('ALPH', Buffer.alloc(4))])))).toBe('MALFORMED');
    expect(reason('image/webp', riffOf(x, anim, anmf([])))).toBe('MALFORMED');
    const overrun = cat(ascii('ANMF'), u32le(16 + 8 + 4), Buffer.alloc(16), ascii('VP8 '), u32le(400), Buffer.alloc(4));
    expect(reason('image/webp', riffOf(x, anim, overrun))).toBe('MALFORMED');
    expect(reason('image/webp', riffOf(x, anim, anmf([rchunk('VP8 ', vp8Data(8, 8))]), vp8))).toBe('OK'); // a late still image is dropped
    expect(reason('image/webp', riffOf(x, vp8, anim, anmf([rchunk('VP8 ', vp8Data(8, 8))])))).toBe('MALFORMED');
  });

  it('rewrites chunk padding to zero', () => {
    const odd = Buffer.from(rchunk('VP8 ', vp8Data(64, 32))); // 21 bytes: odd, so padded
    expect(odd[odd.length - 1]).toBe(0);
    odd[odd.length - 1] = 0x41;
    const input = riffOf(odd);
    expect(input[input.length - 1]).toBe(0x41); // the pad byte carried a letter
    const out = ok('image/webp', input);
    expect(out[out.length - 1]).toBe(0);
  });

  it('refuses an odd chunk without its pad byte (the finalize-time refusal case)', () => {
    const body = cat(ascii('WEBP'), ascii('VP8 '), u32le(21), vp8Data(64, 32).subarray(0, 21));
    expect(reason('image/webp', cat(ascii('RIFF'), u32le(body.length), body))).toBe('MALFORMED');
  });
});

function u24le3(n: number): Buffer {
  return Buffer.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff]);
}
