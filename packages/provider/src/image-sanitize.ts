// Container-level image sanitiser (PRO-002). Photos are verified by HEADER only and keep their metadata (EXIF GPS, camera serials, XMP, text chunks, trailing bytes: DEBT-0099), so the
// public profile photo is never served as stored: it passes through this PURE function first. There is NO decoding and NO re-encoding: the function walks the container (JPEG markers,
// PNG chunks, RIFF chunks) and builds the output from an ALLOW-LIST of recognised parts. The rule for every part is the same:
//
//   recognised AND its declared layout is exactly what the format defines  ->  kept (or REWRITTEN to its canonical form, so spare bytes cannot ride along);
//   recognised but optional and not valid                                   ->  DROPPED;
//   structural (frame, scan, table, header) and not valid                   ->  the file is REFUSED;
//   not recognised                                                          ->  DROPPED (or refused when it is a marker the format reserves);
//
// so a kept part is never copied on the strength of its name or prefix alone. Nothing is copied on trust of a length: each kept part is parsed to its end.
//
//  JPEG  kept: SOI, JFIF (rewritten to exactly 16 bytes, thumbnail 0x0, only version 1 / units 0..2), Adobe APP14 (rewritten to exactly 12 payload bytes), ICC APP2 (only when ALL chunks
//        form a complete sequence 1..N with a valid ICC profile header, within ICC_MAX_BYTES), DQT, DHT, SOF0/SOF1/SOF2, DRI, SOS with its entropy-coded data, EOI; every table and
//        header is checked down to its last byte. EXIF is replaced by a MINIMAL EXIF carrying only a valid Orientation. Dropped: EXIF/XMP (APP1), IPTC, COM, MPF, JFXX, every other
//        APPn and JPGn, stray RSTn/TEM outside a scan, fill bytes, everything after EOI. Refused: any other marker (lossless and arithmetic frames, DNL, DHP, EXP, DAC, reserved).
//  PNG   kept: IHDR (validated), PLTE (validated), IDAT, IEND, sRGB (1 byte), gAMA (4), cHRM (32), pHYs (9), tRNS (exact for the colour type), iCCP (profile name, method 0 and a zlib
//        stream that inflates, within the cap, to a valid ICC profile with nothing after the stream), each once and before the image data. Dropped: everything else (text, eXIf, tIME,
//        animation, unknown ancillary) and everything after IEND.
//  WebP  kept: VP8X (exactly 10 bytes, reserved bits zeroed, EXIF/XMP flags cleared, ICC and animation flags recomputed), ICCP (valid ICC profile within the cap), ALPH, VP8, VP8L, ANIM
//        (exactly 6), ANMF (REBUILT: its 16-byte frame header with reserved bits zeroed and only its ALPH/VP8/VP8L sub-chunks, with the size rewritten). Chunk padding is rewritten
//        to zero. Dropped: EXIF, XMP and every other chunk, and bytes past the RIFF size.
//
// What this does NOT remove: the entropy-coded scan, the compressed bitstreams (IDAT, VP8, VP8L, ALPH), colour tables and ICC profile bodies are the image itself and are copied as they
// are; data hidden inside them (steganography, an ICC tag area) is not detectable at container level.
//
// A truncated, malformed or hostile container is REFUSED with a typed result; the function never throws. Work is linear in the input (every loop step advances by at least one byte, each
// claimed length is checked against the bytes that are really there before it is used, nothing is allocated from a claimed length; the one decompression, an ICC profile, is bounded by
// ICC_MAX_BYTES) and the output buffer is allocated once, bounded by the input size plus a constant.
import { inflateSync } from 'node:zlib';
import { GIG_MEDIA_FILE_CEILING } from '@bananagig/contracts';

export const IMAGE_SANITIZE_FAILURES = ['UNSUPPORTED_TYPE', 'SIGNATURE_MISMATCH', 'TOO_LARGE', 'TRUNCATED', 'MALFORMED'] as const;
export type ImageSanitizeFailure = (typeof IMAGE_SANITIZE_FAILURES)[number];
export type ImageSanitizeResult = { ok: true; bytes: Buffer } | { ok: false; reason: ImageSanitizeFailure };

class Refusal extends Error {
  constructor(readonly reason: ImageSanitizeFailure) {
    super(reason);
  }
}
const refuse = (reason: ImageSanitizeFailure): never => {
  throw new Refusal(reason);
};

// ---------------------------------------------------------------- output: ONE allocation, runs of kept source bytes are copied in as few blocks as possible
/** Room for what the sanitiser may ADD (the minimal EXIF segment, 36 bytes, or a rewritten header): a constant. */
const OUT_HEADROOM = 64;
/** The largest ICC profile kept (after inflation for PNG). A bigger one is dropped, not truncated: the picture then renders without a profile. */
export const ICC_MAX_BYTES = 262_144;
class Out {
  readonly buf: Buffer;
  length = 0;
  private from = -1;
  private to = -1;
  constructor(
    private readonly src: Buffer,
    capacity: number,
  ) {
    this.buf = Buffer.allocUnsafe(capacity);
  }
  /** Keeps the source bytes [from, to). Adjacent ranges are merged into one copy. */
  take(from: number, to: number): void {
    if (to <= from) return;
    if (this.to === from) {
      this.to = to;
      return;
    }
    this.flush();
    this.from = from;
    this.to = to;
  }
  /** Writes bytes that are not in the source. */
  put(bytes: Uint8Array): void {
    this.flush();
    if (this.length + bytes.byteLength > this.buf.byteLength) refuse('MALFORMED');
    this.buf.set(bytes, this.length);
    this.length += bytes.byteLength;
  }
  private flush(): void {
    if (this.to > this.from && this.from >= 0) {
      const n = this.to - this.from;
      if (this.length + n > this.buf.byteLength) refuse('MALFORMED');
      this.src.copy(this.buf, this.length, this.from, this.to);
      this.length += n;
    }
    this.from = -1;
    this.to = -1;
  }
  finish(): Buffer {
    this.flush();
    return this.buf.subarray(0, this.length);
  }
}

const be16 = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!;
const be32 = (b: Uint8Array, at: number): number => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const le32 = (b: Uint8Array, at: number): number => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const startsWith = (b: Uint8Array, at: number, end: number, text: string): boolean => {
  if (at + text.length > end) return false;
  for (let k = 0; k < text.length; k++) if (b[at + k] !== text.charCodeAt(k)) return false;
  return true;
};

const ZERO = Buffer.from([0]);
/** Whether `profile` [at, at+avail) of a total of `total` bytes looks like an ICC profile: size field, `acsp` signature, a sane tag table (as far as the bytes at hand show it). */
function iccLooksValid(b: Uint8Array, at: number, avail: number, total: number): boolean {
  if (total < 132 || total > ICC_MAX_BYTES || avail < 132 || avail > total) return false;
  if (be32(b, at) !== total || !startsWith(b, at + 36, at + avail, 'acsp')) return false;
  const tags = be32(b, at + 128);
  if (tags > 256 || 132 + 12 * tags > total) return false;
  for (let k = 0; k < tags && 132 + 12 * (k + 1) <= avail; k++) {
    const e = at + 132 + 12 * k;
    if (be32(b, e + 4) < 132 + 12 * tags || be32(b, e + 4) + be32(b, e + 8) > total) return false;
  }
  return true;
}
// ---------------------------------------------------------------- JPEG
/** The minimal EXIF APP1 segment: big-endian TIFF, one IFD with the single Orientation tag (SHORT, count 1), no next IFD. 36 bytes including the marker. */
function minimalExif(orientation: number): Buffer {
  return Buffer.from([
    0xff,
    0xe1,
    0x00,
    0x22, // marker, length 34
    0x45,
    0x78,
    0x69,
    0x66,
    0x00,
    0x00, // "Exif\0\0"
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08, // "MM", 42, IFD0 at offset 8
    0x00,
    0x01, // one entry
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    orientation,
    0x00,
    0x00, // Orientation, SHORT, 1, value (big endian)
    0x00,
    0x00,
    0x00,
    0x00, // no next IFD
  ]);
}

/** The Orientation (1..8) of an EXIF APP1 payload [start, end) that begins with `Exif\0\0`, or null. Every offset and count is checked against the segment. */
function exifOrientation(b: Uint8Array, start: number, end: number): number | null {
  const t = start + 6; // the TIFF header
  const size = end - t;
  if (size < 8) return null;
  const little = b[t] === 0x49 && b[t + 1] === 0x49;
  const big = b[t] === 0x4d && b[t + 1] === 0x4d;
  if (!little && !big) return null;
  const u16 = (at: number): number => (little ? b[at]! | (b[at + 1]! << 8) : (b[at]! << 8) | b[at + 1]!);
  const u32 = (at: number): number => (little ? (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0 : be32(b, at));
  if (u16(t + 2) !== 42) return null;
  const ifd = u32(t + 4);
  if (ifd < 8 || ifd > size - 2) return null;
  const claimed = u16(t + ifd);
  const entries = Math.min(claimed, Math.floor((size - ifd - 2) / 12));
  for (let k = 0; k < entries; k++) {
    const e = t + ifd + 2 + k * 12;
    if (u16(e) !== 0x0112) continue;
    if (u16(e + 2) !== 3 || u32(e + 4) !== 1) return null;
    const v = u16(e + 8);
    return v >= 1 && v <= 8 ? v : null;
  }
  return null;
}

const JFIF_SEGMENT_LENGTH = 16;
const ADOBE_PAYLOAD_LENGTH = 12;

/** DQT: one or more tables, each `Pq|Tq` and 64 (8-bit) or 128 (16-bit) values, consuming the payload exactly. */
function validDqt(b: Uint8Array, p: number, end: number): boolean {
  if (p >= end) return false;
  while (p < end) {
    const pq = b[p]! >> 4;
    if (pq > 1 || (b[p]! & 15) > 3) return false;
    p += 1 + 64 * (pq + 1);
    if (p > end) return false;
  }
  return true;
}
/** DHT: one or more tables, each `Tc|Th`, 16 code-length counts and as many symbols as they add up to (at most 256), consuming the payload exactly. */
function validDht(b: Uint8Array, p: number, end: number): boolean {
  if (p >= end) return false;
  while (p < end) {
    if (b[p]! >> 4 > 1 || (b[p]! & 15) > 3 || p + 17 > end) return false;
    let symbols = 0;
    for (let k = 1; k <= 16; k++) symbols += b[p + k]!;
    if (symbols > 256) return false;
    p += 17 + symbols;
    if (p > end) return false;
  }
  return true;
}
/** SOF0/1/2: precision, height, width (both >= 1), 1..4 components of three bytes each (sampling factors 1..4, quantization table 0..3), the length exactly that. */
function validSof(b: Uint8Array, marker: number, p: number, end: number): number | null {
  if (end - p < 9) return null;
  const precision = b[p]!;
  if (precision !== 8 && !(marker === 0xc1 && precision === 12)) return null;
  if (be16(b, p + 1) < 1 || be16(b, p + 3) < 1) return null;
  const components = b[p + 5]!;
  if (components < 1 || components > 4 || end - p !== 6 + 3 * components) return null;
  for (let k = 0; k < components; k++) {
    const q = p + 6 + 3 * k;
    const h = b[q + 1]! >> 4;
    const v = b[q + 1]! & 15;
    if (h < 1 || h > 4 || v < 1 || v > 4 || b[q + 2]! > 3) return null;
  }
  return components;
}
/** SOS: 1..4 components (not more than the frame has) with table selectors, then spectral start/end (<= 63) and successive approximation (<= 13), the length exactly that. */
function validSos(b: Uint8Array, p: number, end: number, frameComponents: number): boolean {
  const ns = b[p]!;
  if (ns < 1 || ns > 4 || ns > frameComponents || end - p !== 1 + 2 * ns + 3) return false;
  for (let k = 0; k < ns; k++) if (b[p + 2 + 2 * k]! >> 4 > 3 || (b[p + 2 + 2 * k]! & 15) > 3) return false;
  const q = p + 1 + 2 * ns;
  return b[q]! <= 63 && b[q + 1]! <= 63 && b[q + 2]! >> 4 <= 13 && (b[q + 2]! & 15) <= 13;
}

/**
 * Whether the ICC chunks of the JPEG header (every APP2 `ICC_PROFILE` before the first scan) form ONE complete, valid profile: sequence numbers 1..N in order with a constant count N, a
 * total within ICC_MAX_BYTES and a valid profile header. A separate cheap pass, because the chunks are kept or dropped as a whole while the output is written in a single sweep.
 */
function jpegHasValidIcc(b: Buffer): boolean {
  const n = b.byteLength;
  let i = 2;
  let next = 1;
  let count = 0;
  let total = 0;
  let first = -1;
  let firstLength = 0;
  while (i < n) {
    if (b[i] !== 0xff) return false;
    while (i < n && b[i] === 0xff) i++;
    if (i >= n) return false;
    const marker = b[i++]!;
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0x00 || marker === 0xd8 || i + 2 > n) return false;
    const length = be16(b, i);
    if (length < 2 || i + length > n) return false;
    if (marker === 0xe2 && startsWith(b, i + 2, i + length, 'ICC_PROFILE\0')) {
      const data = length - 16; // length, signature (12), sequence number, count
      const seq = b[i + 14];
      const of = b[i + 15];
      if (data < 1 || of === undefined || of < 1 || seq !== next || (count !== 0 && of !== count)) return false;
      count = of;
      if (seq === 1) {
        first = i + 16;
        firstLength = data;
      }
      total += data;
      if (total > ICC_MAX_BYTES) return false;
      next++;
    }
    i += length;
  }
  return count > 0 && next - 1 === count && iccLooksValid(b, first, firstLength, total);
}

function sanitizeJpeg(b: Buffer): Buffer {
  const n = b.byteLength;
  if (n < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return refuse('SIGNATURE_MISMATCH');
  const iccOk = jpegHasValidIcc(b);
  const out = new Out(b, n + OUT_HEADROOM);
  out.take(0, 2); // SOI
  let i = 2;
  let frameComponents = 0;
  let sawScan = false;
  let exifHandled = false;
  let jfifDone = false;
  let adobeDone = false;
  for (;;) {
    if (i >= n) return refuse('TRUNCATED');
    if (b[i] !== 0xff) return refuse('MALFORMED');
    while (i < n && b[i] === 0xff) i++; // fill bytes are never copied: a kept segment starts at the one 0xFF directly before its marker
    if (i >= n) return refuse('TRUNCATED');
    const marker = b[i++]!;
    const start = i - 2;
    if (marker === 0xd9) {
      // EOI: the end of the image. Everything after it is dropped.
      if (!sawScan) return refuse('MALFORMED');
      out.take(start, i);
      return out.finish();
    }
    if (marker === 0x00 || marker === 0xd8) return refuse('MALFORMED');
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // TEM and RSTn outside a scan carry nothing: dropped
    if (i + 2 > n) return refuse('TRUNCATED');
    const length = be16(b, i);
    if (length < 2) return refuse('MALFORMED');
    const end = i + length;
    if (end > n) return refuse('TRUNCATED');
    const body = i + 2; // payload start
    switch (marker) {
      case 0xe0: // JFIF: rewritten to its canonical 16 bytes (a thumbnail or any extra bytes are gone)
        if (
          !jfifDone &&
          frameComponents === 0 &&
          length >= JFIF_SEGMENT_LENGTH &&
          startsWith(b, body, end, 'JFIF\0') &&
          b[body + 5] === 1 &&
          b[body + 7]! <= 2
        ) {
          jfifDone = true;
          out.put(Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, JFIF_SEGMENT_LENGTH]), b.subarray(body, body + 12), Buffer.from([0, 0])]));
        }
        break;
      case 0xe1: // APP1: EXIF becomes a minimal Orientation-only EXIF in its place; XMP and the rest are dropped
        if (!exifHandled && startsWith(b, body, end, 'Exif\0\0')) {
          exifHandled = true;
          const o = exifOrientation(b, body, end);
          if (o !== null) out.put(minimalExif(o));
        }
        break;
      case 0xe2: // ICC: only as part of a complete valid profile, before the image data
        if (iccOk && !sawScan && startsWith(b, body, end, 'ICC_PROFILE\0')) out.take(start, end);
        break;
      case 0xee: // Adobe: rewritten to its canonical 12 payload bytes
        if (!adobeDone && !sawScan && length >= 2 + ADOBE_PAYLOAD_LENGTH && startsWith(b, body, end, 'Adobe') && b[body + 11]! <= 2) {
          adobeDone = true;
          out.put(Buffer.concat([Buffer.from([0xff, 0xee, 0x00, 2 + ADOBE_PAYLOAD_LENGTH]), b.subarray(body, body + ADOBE_PAYLOAD_LENGTH)]));
        }
        break;
      case 0xdb:
        if (!validDqt(b, body, end)) return refuse('MALFORMED');
        out.take(start, end);
        break;
      case 0xc4:
        if (!validDht(b, body, end)) return refuse('MALFORMED');
        out.take(start, end);
        break;
      case 0xdd:
        if (length !== 4) return refuse('MALFORMED');
        out.take(start, end);
        break;
      case 0xc0:
      case 0xc1:
      case 0xc2: {
        const components = frameComponents === 0 ? validSof(b, marker, body, end) : null; // a second frame is refused
        if (components === null) return refuse('MALFORMED');
        frameComponents = components;
        out.take(start, end);
        break;
      }
      case 0xda:
        if (frameComponents === 0 || !validSos(b, body, end, frameComponents)) return refuse('MALFORMED');
        sawScan = true;
        out.take(start, end);
        break;
      default:
        // other APPn, COM, JPGn: dropped. Anything else (lossless and arithmetic frames, DNL, DHP, EXP, DAC, reserved markers) is not something this build can validate: refused.
        if (!((marker >= 0xe3 && marker <= 0xed) || marker === 0xef || (marker >= 0xf0 && marker <= 0xfe))) return refuse('MALFORMED');
    }
    i = end;
    if (marker === 0xda) {
      // entropy-coded data: byte stuffing (FF00), restart markers (FFD0..FFD7) and fill (FFFF) belong to the scan; any other marker ends it
      let p = i;
      for (;;) {
        p = b.indexOf(0xff, p);
        if (p < 0 || p + 1 >= n) return refuse('TRUNCATED');
        const next = b[p + 1]!;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) p += 2;
        else if (next === 0xff) p += 1;
        else break;
      }
      out.take(i, p);
      i = p;
    }
  }
}

// ---------------------------------------------------------------- PNG
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isAsciiLetter = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
/** The allowed (colour type -> bit depths) pairs of IHDR. */
const PNG_DEPTHS: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

/** iCCP: a profile name (1..79 Latin-1 printable characters, no leading, trailing or doubled space), a NUL, compression method 0 and a zlib stream that inflates to a valid ICC profile. */
function validIccp(b: Uint8Array, p: number, end: number): boolean {
  let k = p;
  while (k < end && k - p < 80 && b[k] !== 0) k++;
  const name = k - p;
  if (name < 1 || name > 79 || k >= end || b[k] !== 0) return false;
  for (let c = p; c < k; c++) {
    const v = b[c]!;
    if (!((v >= 32 && v <= 126) || v >= 161)) return false;
    if (v === 32 && (c === p || c === k - 1 || b[c + 1] === 32)) return false;
  }
  if (b[k + 1] !== 0 || end - (k + 2) < 8 || end - (k + 2) > ICC_MAX_BYTES) return false;
  const stream = Buffer.from(b.subarray(k + 2, end));
  try {
    const r = inflateSync(stream, { maxOutputLength: ICC_MAX_BYTES, info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    // the stream must end exactly where the chunk data ends, and what it holds must be an ICC profile
    return r.engine.bytesWritten === stream.byteLength && iccLooksValid(r.buffer, 0, r.buffer.byteLength, r.buffer.byteLength);
  } catch {
    return false;
  }
}

function sanitizePng(b: Buffer): Buffer {
  const n = b.byteLength;
  if (n < 8 || !PNG_SIGNATURE.every((v, k) => b[k] === v)) return refuse('SIGNATURE_MISMATCH');
  const out = new Out(b, n + OUT_HEADROOM);
  out.take(0, 8);
  let pos = 8;
  let colorType = -1;
  let bitDepth = 0;
  let palette = 0;
  let sawIdat = false;
  const seen = new Set<string>();
  for (;;) {
    if (pos + 8 > n) return refuse('TRUNCATED');
    const length = be32(b, pos);
    if (length > 0x7fffffff) return refuse('MALFORMED');
    for (let k = 4; k < 8; k++) if (!isAsciiLetter(b[pos + k]!)) return refuse('MALFORMED');
    const end = pos + 12 + length; // length, type, data, CRC
    if (end > n) return refuse('TRUNCATED');
    const type = b.toString('latin1', pos + 4, pos + 8);
    const data = pos + 8;
    if (colorType < 0) {
      // the first chunk is IHDR: size, bit depth / colour type pair, methods 0, interlace 0 or 1
      if (type !== 'IHDR' || length !== 13) return refuse('MALFORMED');
      colorType = b[data + 9]!;
      bitDepth = b[data + 8]!;
      const depths = PNG_DEPTHS[colorType];
      if (
        !depths ||
        !depths.includes(b[data + 8]!) ||
        be32(b, data) < 1 ||
        be32(b, data) > 0x7fffffff ||
        be32(b, data + 4) < 1 ||
        be32(b, data + 4) > 0x7fffffff
      )
        return refuse('MALFORMED');
      if (b[data + 10] !== 0 || b[data + 11] !== 0 || b[data + 12]! > 1) return refuse('MALFORMED');
      out.take(pos, end);
      pos = end;
      continue;
    }
    switch (type) {
      case 'IHDR':
        return refuse('MALFORMED');
      case 'PLTE': {
        // a palette: 1..256 entries (not more than the bit depth allows), only for colour types 2, 3 and 6, before the image data
        if (sawIdat || seen.has(type) || colorType === 0 || colorType === 4 || length % 3 !== 0 || length < 3 || length > 768) return refuse('MALFORMED');
        if (colorType === 3 && length / 3 > 2 ** bitDepth) return refuse('MALFORMED');
        seen.add(type);
        palette = length / 3;
        out.take(pos, end);
        break;
      }
      case 'IDAT':
        if (colorType === 3 && !seen.has('PLTE')) return refuse('MALFORMED');
        sawIdat = true;
        out.take(pos, end);
        break;
      case 'IEND':
        if (length !== 0 || !sawIdat) return refuse('MALFORMED');
        out.take(pos, end);
        return out.finish(); // everything after IEND is dropped
      default: {
        // ancillary chunks: each at most once, before the image data, with exactly the layout the format defines; anything else is dropped
        if (sawIdat || seen.has(type)) break;
        let ok = false;
        if (type === 'sRGB') ok = length === 1 && b[data]! <= 3;
        else if (type === 'gAMA') ok = length === 4;
        else if (type === 'cHRM') ok = length === 32;
        else if (type === 'pHYs') ok = length === 9 && b[data + 8]! <= 1;
        else if (type === 'tRNS')
          ok = (colorType === 0 && length === 2) || (colorType === 2 && length === 6) || (colorType === 3 && length >= 1 && length <= palette);
        else if (type === 'iCCP') ok = !seen.has('PLTE') && validIccp(b, data, data + length);
        if (ok) {
          seen.add(type);
          out.take(pos, end);
        }
      }
    }
    pos = end;
  }
}

// ---------------------------------------------------------------- WebP (RIFF)
const VP8X_FLAG_ALPHA = 0x10;
const VP8X_FLAG_ICC = 0x20;
const VP8X_FLAG_ANIMATION = 0x02;

function sanitizeWebp(b: Buffer): Buffer {
  const n = b.byteLength;
  if (n < 12 || !startsWith(b, 0, n, 'RIFF') || !startsWith(b, 8, n, 'WEBP')) return refuse('SIGNATURE_MISMATCH');
  const riffSize = le32(b, 4);
  if (riffSize < 4) return refuse('MALFORMED');
  const end = riffSize + 8; // bytes past the declared container are dropped
  if (end > n) return refuse('TRUNCATED');
  const out = new Out(b, end + OUT_HEADROOM);
  out.put(Buffer.from(b.subarray(0, 12))); // the RIFF size is patched at the end

  /** The extent of the chunk at `pos` inside [.., limit): its payload size and its end including the pad byte. Refuses a chunk that does not fit. */
  const extent = (pos: number, limit: number): { size: number; next: number } => {
    if (pos + 8 > limit) return refuse('MALFORMED');
    const size = le32(b, pos + 4);
    if (size > limit - pos - 8) return refuse('TRUNCATED');
    const next = pos + 8 + size + (size & 1);
    if (next > limit) return refuse('MALFORMED'); // an odd chunk without its pad byte
    return { size, next };
  };
  /** Keeps a chunk: header and payload as they are, the pad byte rewritten to zero. */
  const emit = (pos: number, size: number): void => {
    out.take(pos, pos + 8 + size);
    if (size & 1) out.put(ZERO);
  };

  // the first chunk decides the shape: a SIMPLE file is one VP8 or VP8L chunk (everything after it is dropped); an EXTENDED file starts with VP8X
  const first = extent(12, end);
  const firstType = b.toString('latin1', 12, 16);
  if (firstType === 'VP8 ' || firstType === 'VP8L') {
    emit(12, first.size);
    return finishWebp(out);
  }
  if (firstType !== 'VP8X' || first.size !== 10) return refuse('MALFORMED');
  const sourceFlags = b[20]!;
  // VP8X: flags recomputed at the end, the three reserved bytes zero, the canvas size as it is
  out.put(Buffer.concat([b.subarray(12, 20), Buffer.from([0, 0, 0, 0]), b.subarray(24, 30)]));
  let pos = first.next;
  let sawIcc = false;
  let sawAlph = false;
  let sawStill = false;
  let sawAnim = false;
  let sawFrame = false;
  while (pos < end) {
    const { size, next } = extent(pos, end);
    const type = b.toString('latin1', pos, pos + 4);
    const data = pos + 8;
    if (type === 'ICCP') {
      if (!sawIcc && !sawAlph && !sawStill && !sawFrame && size <= ICC_MAX_BYTES && iccLooksValid(b, data, size, size)) {
        sawIcc = true;
        emit(pos, size);
      }
    } else if (type === 'ALPH') {
      if (!sawAlph && !sawStill && !sawAnim) {
        sawAlph = true;
        emit(pos, size);
      }
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (!sawStill && !sawAnim) {
        sawStill = true;
        emit(pos, size);
      }
    } else if (type === 'ANIM') {
      if (!sawAnim && !sawStill && !sawAlph) {
        if (size !== 6) return refuse('MALFORMED');
        sawAnim = true;
        emit(pos, size);
      }
    } else if (type === 'ANMF') {
      if (!sawAnim) return refuse('MALFORMED'); // a frame needs the animation header first
      sawFrame = true;
      emitFrame(b, out, pos, size);
    }
    pos = next;
  }
  if (!sawStill && !sawFrame) return refuse('MALFORMED');
  if (sawFrame === sawStill) return refuse('MALFORMED'); // a still image and frames never mix
  const result = finishWebp(out);
  result[20] = (sourceFlags & VP8X_FLAG_ALPHA) | (sawIcc ? VP8X_FLAG_ICC : 0) | (sawFrame ? VP8X_FLAG_ANIMATION : 0);
  return result;
}

function finishWebp(out: Out): Buffer {
  const result = out.finish();
  result.writeUInt32LE(result.byteLength - 8, 4);
  return result;
}

/** ANMF: rebuilt from its 16-byte frame header (reserved bits zeroed) and its ALPH / VP8 / VP8L sub-chunks only; the chunk size is rewritten. */
function emitFrame(b: Buffer, out: Out, pos: number, size: number): void {
  const dataStart = pos + 8;
  const limit = dataStart + size;
  if (size < 16 + 8) return refuse('MALFORMED');
  const walk = (emit: boolean): number => {
    let kept = 0;
    let p = dataStart + 16;
    let sawAlph = false;
    let sawImage = false;
    while (p < limit) {
      if (p + 8 > limit) return refuse('MALFORMED');
      const sub = le32(b, p + 4);
      if (sub > limit - p - 8) return refuse('MALFORMED');
      const next = p + 8 + sub + (sub & 1);
      if (next > limit) return refuse('MALFORMED');
      const type = b.toString('latin1', p, p + 4);
      const keep = (type === 'ALPH' && !sawAlph && !sawImage) || ((type === 'VP8 ' || type === 'VP8L') && !sawImage);
      if (keep) {
        if (type === 'ALPH') sawAlph = true;
        else sawImage = true;
        kept += 8 + sub + (sub & 1);
        if (emit) {
          out.take(p, p + 8 + sub);
          if (sub & 1) out.put(ZERO);
        }
      }
      p = next;
    }
    if (!sawImage) return refuse('MALFORMED');
    return kept;
  };
  const kept = walk(false);
  const header = Buffer.from(b.subarray(dataStart, dataStart + 16));
  header[15] = header[15]! & 0x03;
  out.put(Buffer.concat([Buffer.from('ANMF', 'latin1'), le32Buffer(16 + kept), header]));
  walk(true);
}
const le32Buffer = (v: number): Buffer => {
  const x = Buffer.alloc(4);
  x.writeUInt32LE(v, 0);
  return x;
};

// ---------------------------------------------------------------- entry point
export interface ImageSanitizeOptions {
  /** Inputs larger than this are refused before any work (the caller passes its own configured limit; the default is the structural ceiling of a stored photo). */
  maxBytes?: number;
}

/**
 * Removes metadata and trailing bytes from a JPEG, PNG or WebP at CONTAINER level (see the file header). `mimeType` is the type recorded for the asset; the bytes must match it.
 * Pure and total: a refusal is a typed result, never an exception. The input is never modified; the returned bytes are a fresh copy.
 */
export function sanitizeImage(mimeType: string, input: Uint8Array, opts: ImageSanitizeOptions = {}): ImageSanitizeResult {
  try {
    const max = Math.min(opts.maxBytes ?? GIG_MEDIA_FILE_CEILING, GIG_MEDIA_FILE_CEILING);
    if (input.byteLength > max) return { ok: false, reason: 'TOO_LARGE' };
    const b = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    let bytes: Buffer;
    switch (mimeType) {
      case 'image/jpeg':
        bytes = sanitizeJpeg(b);
        break;
      case 'image/png':
        bytes = sanitizePng(b);
        break;
      case 'image/webp':
        bytes = sanitizeWebp(b);
        break;
      default:
        return { ok: false, reason: 'UNSUPPORTED_TYPE' };
    }
    return { ok: true, bytes: Buffer.from(bytes) };
  } catch (e) {
    return { ok: false, reason: e instanceof Refusal ? e.reason : 'MALFORMED' };
  }
}
