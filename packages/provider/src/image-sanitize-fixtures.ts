// Image fixtures for the sanitiser tests and the profile photo tests (PRO-002): REAL container layouts built in code (JPEG markers with a real EXIF/TIFF structure including a GPS IFD, PNG
// chunks with real CRCs, RIFF/WebP chunks). Test support only: nothing in the production code imports this file.
// ---------------------------------------------------------------- builders
import { deflateSync } from 'node:zlib';

/** A minimal but structurally valid ICC profile: the 128-byte header (size, `acsp`), an empty tag table and optional extra tag bytes. */
export function iccProfile(extra = 0): Buffer {
  const total = 132 + extra;
  const b = Buffer.alloc(total, 0x11);
  b.fill(0, 0, 132);
  b.writeUInt32BE(total, 0);
  b.write('acsp', 36, 'latin1');
  return b;
}
/** The data of an iCCP chunk: profile name, method 0 and the zlib stream of a valid profile. */
export function iccpData(name = 'icc'): Buffer {
  return Buffer.concat([Buffer.from(`${name}\0`, 'latin1'), Buffer.from([0]), deflateSync(iccProfile(200))]);
}

export const ascii = (s: string): Buffer => Buffer.from(s, 'latin1');
export const u16be = (n: number): Buffer => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
export const u32be = (n: number): Buffer => Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
export const u32le = (n: number): Buffer => Buffer.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
export const u24le = (n: number): Buffer => Buffer.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff]);
export const catList = (p: (Buffer | number[])[]): Buffer => Buffer.concat(p.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x))));
export const cat = (...p: (Buffer | number[])[]): Buffer => catList(p);
export const has = (hay: Buffer, needle: string | Buffer): boolean => hay.includes(needle);
export const count = (hay: Buffer, needle: string): number => {
  let c = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) c++;
  return c;
};

export const SECRETS = [
  'SECRET-GPS',
  'SECRET-CAMERA',
  'SECRET-XMP',
  'SECRET-IPTC',
  'SECRET-COMMENT',
  'SECRET-TEXT',
  'SECRET-EXIF',
  'SECRET-TAIL',
  'SECRET-THUMB',
];

// A real EXIF/TIFF block: IFD0 with ImageDescription, Orientation and a GPS pointer, and a GPS IFD with the reference and a latitude rational.
export function exifTiff(opts: { little: boolean; orientation?: number; gps?: boolean; rawOrientationValue?: number }): Buffer {
  const { little } = opts;
  const w16 = (n: number) => (little ? Buffer.from([n & 0xff, (n >> 8) & 0xff]) : u16be(n));
  const w32 = (n: number) => (little ? u32le(n) : u32be(n));
  const entry = (tag: number, type: number, cnt: number, value: Buffer): Buffer => cat(w16(tag), w16(type), w32(cnt), value);
  const description = cat(ascii('SECRET-CAMERA-SERIAL-12345'), [0]);
  const entries: { tag: number; type: number; count: number; inline?: Buffer; data?: Buffer }[] = [
    { tag: 0x010e, type: 2, count: description.length, data: description },
  ];
  if (opts.orientation !== undefined || opts.rawOrientationValue !== undefined)
    entries.push({ tag: 0x0112, type: 3, count: 1, inline: cat(w16(opts.rawOrientationValue ?? opts.orientation!), [0, 0]) });
  if (opts.gps) entries.push({ tag: 0x8825, type: 4, count: 1 }); // value patched below
  const ifdSize = 2 + entries.length * 12 + 4;
  let dataAt = 8 + ifdSize;
  const parts: Buffer[] = [];
  const rendered = entries.map((e) => {
    if (e.data) {
      const at = dataAt;
      dataAt += e.data.length;
      parts.push(e.data);
      return entry(e.tag, e.type, e.count, w32(at));
    }
    return e.inline ? entry(e.tag, e.type, e.count, e.inline) : null;
  });
  let gpsIfd: Buffer | null = null;
  if (opts.gps) {
    const gpsAt = dataAt;
    const latData = cat(w32(40), w32(1), w32(26), w32(1), w32(46), w32(100)); // 40 deg 26' 46.0" (a real-looking coordinate)
    const gpsEntries = 2;
    const gpsIfdSize = 2 + gpsEntries * 12 + 4;
    const latAt = gpsAt + gpsIfdSize;
    gpsIfd = cat(w16(gpsEntries), entry(0x0001, 2, 2, ascii('N\0\0\0')), entry(0x0002, 5, 3, w32(latAt)), w32(0), latData, ascii('SECRET-GPS-POSITION\0'));
    const idx = entries.findIndex((e) => e.tag === 0x8825);
    rendered[idx] = entry(0x8825, 4, 1, w32(gpsAt));
  }
  return cat(little ? ascii('II*\0') : ascii('MM\0*'), w32(8), w16(entries.length), ...rendered.map((r) => r!), w32(0), ...parts, ...(gpsIfd ? [gpsIfd] : []));
}
export const exifSegment = (tiff: Buffer): Buffer => segment(0xe1, cat(ascii('Exif\0\0'), tiff));

export const segment = (marker: number, payload: Buffer): Buffer => cat([0xff, marker], u16be(payload.length + 2), payload);

/** Entropy-coded data with stuffed bytes (FF00), restart markers and fill, as a real scan has. */
export const ENTROPY = cat([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0x00, 0xff, 0xff, 0xd1, 0x78, 0x9a, 0xff, 0x00, 0xbc]);

export interface JpegOpts {
  w?: number;
  h?: number;
  exif?: Buffer; // a ready-made APP1
  trailing?: Buffer;
  progressive?: boolean;
}
/** The image part (from the first DQT through EOI): what must come out byte-identical. */
export function jpegImagePart(w: number, h: number, progressive = false): Buffer {
  const dqt = segment(0xdb, cat([0x00], Buffer.alloc(64, 7)));
  const sof = segment(progressive ? 0xc2 : 0xc0, cat([8], u16be(h), u16be(w), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]));
  const dht = segment(0xc4, cat([0x00], [2], Buffer.alloc(15, 0), [0x01, 0x02]));
  const sos = (): Buffer => cat(segment(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0])), ENTROPY);
  return cat(dqt, sof, dht, sos(), ...(progressive ? [segment(0xc4, cat([0x10], [1], Buffer.alloc(15, 0), [0x03])), sos()] : []), [0xff, 0xd9]);
}
export function jpeg(o: JpegOpts = {}): { file: Buffer; image: Buffer } {
  const image = jpegImagePart(o.w ?? 640, o.h ?? 480, o.progressive);
  const jfif = segment(0xe0, cat(ascii('JFIF\0'), [1, 1, 0, 0, 1, 0, 1, 0, 0]));
  const xmp = segment(0xe1, cat(ascii('http://ns.adobe.com/xap/1.0/\0'), ascii('<x:xmpmeta>SECRET-XMP</x:xmpmeta>')));
  const iptc = segment(0xed, cat(ascii('Photoshop 3.0\0'), ascii('8BIM'), ascii('SECRET-IPTC')));
  const com = segment(0xfe, ascii('SECRET-COMMENT'));
  const icc = segment(0xe2, cat(ascii('ICC_PROFILE\0'), [1, 1], iccProfile()));
  const mpf = segment(0xe2, cat(ascii('MPF\0'), Buffer.alloc(30, 5)));
  const jfxx = segment(0xe0, cat(ascii('JFXX\0'), [0x10], ascii('SECRET-THUMB')));
  const adobe = segment(0xee, cat(ascii('Adobe'), [0, 100, 0, 0, 0, 0, 1]));
  const trailing = o.trailing ?? cat(ascii('SECRET-TAIL'), [0xff, 0xd8, 0xff, 0xe0], ascii('PK\x03\x04<script>alert(1)</script>'));
  const file = cat([0xff, 0xd8], jfif, jfxx, ...(o.exif ? [o.exif] : []), xmp, iptc, com, icc, mpf, adobe, image, trailing);
  return { file, image };
}

export const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export const crc32 = (b: Buffer): number => {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
export const chunk = (type: string, data: Buffer): Buffer => cat(u32be(data.length), ascii(type), data, u32be(crc32(cat(ascii(type), data))));
export const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const ihdr = (w: number, h: number): Buffer => chunk('IHDR', cat(u32be(w), u32be(h), [8, 2, 0, 0, 0]));
export function png(o: { w?: number; h?: number; trailing?: Buffer } = {}): { file: Buffer; kept: Buffer[]; all: Buffer } {
  const kept = [
    ihdr(o.w ?? 320, o.h ?? 200),
    chunk('gAMA', u32be(45455)),
    chunk('sRGB', Buffer.from([0])),
    chunk('cHRM', Buffer.alloc(32, 3)),
    chunk('pHYs', cat(u32be(2835), u32be(2835), [1])),
    chunk('iCCP', iccpData()),
    chunk('tRNS', Buffer.from([0, 0, 0, 0, 0, 0])),
    chunk('IDAT', Buffer.alloc(50, 0x55)),
    chunk('IDAT', Buffer.alloc(30, 0x66)),
    chunk('IEND', Buffer.alloc(0)),
  ];
  const dropped = [
    chunk('tEXt', cat(ascii('Comment\0'), ascii('SECRET-TEXT'))),
    chunk('zTXt', cat(ascii('k\0'), [0], ascii('SECRET-TEXT'))),
    chunk('iTXt', cat(ascii('k\0'), [0, 0], ascii('\0\0SECRET-TEXT'))),
    chunk('eXIf', cat(ascii('SECRET-EXIF'), exifTiff({ little: false, orientation: 6, gps: true }))),
    chunk('tIME', Buffer.from([0x07, 0xe8, 1, 2, 3, 4, 5])),
    chunk('prVT', ascii('SECRET-EXIF')),
  ];
  const all = cat(
    PNG_SIG,
    kept[0]!,
    dropped[0]!,
    kept[1]!,
    dropped[1]!,
    kept[2]!,
    kept[3]!,
    dropped[2]!,
    kept[4]!,
    dropped[3]!,
    kept[5]!,
    kept[6]!,
    dropped[4]!,
    kept[7]!,
    dropped[5]!,
    kept[8]!,
    kept[9]!,
  );
  const trailing = o.trailing ?? cat(ascii('SECRET-TAIL'), ascii('<script>alert(1)</script>'), PNG_SIG, kept[0]!);
  return { file: cat(all, trailing), kept, all };
}

export const riffList = (chunks: Buffer[]): Buffer => {
  const body = catList([ascii('WEBP'), ...chunks]);
  return cat(ascii('RIFF'), u32le(body.length), body);
};
export const riffOf = (...chunks: Buffer[]): Buffer => riffList(chunks);
export const rchunk = (type: string, data: Buffer): Buffer => cat(ascii(type), u32le(data.length), data, data.length & 1 ? [0] : []);
export const vp8x = (flags: number, w: number, h: number): Buffer => rchunk('VP8X', cat([flags, 0, 0, 0], u24le(w - 1), u24le(h - 1)));
export const vp8Data = (w: number, h: number): Buffer =>
  cat([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a], [w & 0xff, (w >> 8) & 0x3f, h & 0xff, (h >> 8) & 0x3f], Buffer.alloc(11, 0x42)); // 21 bytes: odd, so padded
export function webp(o: { trailing?: Buffer } = {}): { file: Buffer; kept: Buffer[] } {
  const kept = [
    vp8x(0x20 | 0x10 | 0x08 | 0x04, 800, 600),
    rchunk('ICCP', iccProfile()),
    rchunk('ALPH', Buffer.alloc(10, 6)),
    rchunk('VP8 ', vp8Data(800, 600)),
  ];
  const exif = rchunk('EXIF', cat(ascii('Exif\0\0'), exifTiff({ little: true, orientation: 6, gps: true })));
  const xmp = rchunk('XMP ', ascii('<x:xmpmeta>SECRET-XMP</x:xmpmeta>'));
  const unknown = rchunk('ZZZZ', ascii('SECRET-EXIF'));
  const file = riffOf(kept[0]!, kept[1]!, exif, kept[2]!, xmp, unknown, kept[3]!);
  return { file: cat(file, o.trailing ?? ascii('SECRET-TAIL<script>')), kept };
}

/** An ANMF chunk: the 16-byte frame header (the last byte is the blend/dispose flags) followed by the given sub-chunks. */
export const anmf = (subChunks: Buffer[], flags = 0): Buffer => rchunk('ANMF', catList([Buffer.alloc(15, 0), Buffer.from([flags]), ...subChunks]));
/** A PNG IHDR chunk with a chosen bit depth, colour type and interlace method. */
export const ihdrOf = (w: number, h: number, depth: number, colorType: number, interlace = 0): Buffer =>
  chunk('IHDR', cat(u32be(w), u32be(h), [depth, colorType, 0, 0, interlace]));
