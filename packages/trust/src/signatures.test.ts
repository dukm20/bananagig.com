// Unit tests of the file-signature check (TRUST-001): the declared content type must match the first bytes of the stored object.
import { describe, expect, it } from 'vitest';
import { SNIFFABLE_MIME_TYPES, matchesSignature } from './signatures';

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const bytes = (head: number[], tail = 8): Uint8Array => Uint8Array.from([...head, ...Array.from({ length: tail }, (_, i) => (i * 7) & 0xff)]);

describe('SNIFFABLE_MIME_TYPES', () => {
  it('is exactly pdf, jpeg and png', () => {
    expect([...SNIFFABLE_MIME_TYPES].sort()).toEqual(['application/pdf', 'image/jpeg', 'image/png']);
  });
});

describe('matchesSignature', () => {
  it.each([
    ['application/pdf', PDF],
    ['image/jpeg', JPEG],
    ['image/png', PNG],
  ] as const)('accepts %s bytes with the right signature', (mime, head) => {
    expect(matchesSignature(mime, bytes([...head]))).toBe(true);
  });
  it('accepts a Buffer and a bare signature with no further bytes', () => {
    expect(matchesSignature('application/pdf', Buffer.from('%PDF-1.4\n%synthetic test fixture\n', 'latin1'))).toBe(true);
    expect(matchesSignature('image/jpeg', Uint8Array.from(JPEG))).toBe(true);
    expect(matchesSignature('image/png', Uint8Array.from(PNG))).toBe(true);
    expect(matchesSignature('application/pdf', Uint8Array.from(PDF))).toBe(true);
  });
  it.each([
    ['application/pdf', PDF],
    ['image/jpeg', JPEG],
    ['image/png', PNG],
  ] as const)('refuses a truncated %s signature (one byte short)', (mime, head) => {
    expect(matchesSignature(mime, Uint8Array.from(head.slice(0, -1)))).toBe(false);
  });
  it('refuses empty input', () => {
    for (const m of SNIFFABLE_MIME_TYPES) expect(matchesSignature(m, new Uint8Array())).toBe(false);
  });
  it.each([
    ['application/pdf', PDF],
    ['image/jpeg', JPEG],
    ['image/png', PNG],
  ] as const)('refuses a %s signature with a wrong byte at every position', (mime, head) => {
    for (let i = 0; i < head.length; i++) {
      const b = [...head];
      b[i] = b[i]! ^ 0x01;
      expect(matchesSignature(mime, bytes(b)), `${mime} byte ${i}`).toBe(false);
    }
  });
  it('refuses a signature that is not at offset 0 (a leading byte or whitespace)', () => {
    expect(matchesSignature('application/pdf', bytes([0x0a, ...PDF]))).toBe(false);
    expect(matchesSignature('application/pdf', bytes([0x20, ...PDF]))).toBe(false);
    expect(matchesSignature('image/png', bytes([0x00, ...PNG]))).toBe(false);
  });
  it('refuses the signature of another supported type (a PNG declared as a PDF, and so on)', () => {
    const heads = { 'application/pdf': PDF, 'image/jpeg': JPEG, 'image/png': PNG } as const;
    for (const declared of SNIFFABLE_MIME_TYPES as (keyof typeof heads)[])
      for (const actual of SNIFFABLE_MIME_TYPES as (keyof typeof heads)[])
        expect(matchesSignature(declared, bytes([...heads[actual]])), `${declared} <- ${actual}`).toBe(declared === actual);
  });
  it('refuses spoofed HTML, script, an executable and plain text declared as a document', () => {
    const spoof = ['<html><body>%PDF-</body></html>', '<!DOCTYPE html><html>', '<script>alert(1)</script>', 'MZ\u0090\u0000\u0003', 'hello world', '%PDF'];
    for (const text of spoof) for (const m of SNIFFABLE_MIME_TYPES) expect(matchesSignature(m, Buffer.from(text, 'latin1')), `${m} ${text}`).toBe(false);
  });
  it('a PDF signature appearing later in an HTML body does not pass', () => {
    expect(matchesSignature('application/pdf', Buffer.from('<html>\n%PDF-1.7', 'latin1'))).toBe(false);
  });
  it.each([
    'text/html',
    'application/zip',
    'image/gif',
    'image/webp',
    'application/octet-stream',
    '',
    'APPLICATION/PDF',
    'application/pdf ',
    'application/pdf; charset=binary',
    'image/jpg',
  ])('returns false for the unsupported or unnormalized content type %j even with valid-looking bytes', (mime) => {
    expect(matchesSignature(mime, bytes([...PDF]))).toBe(false);
    expect(matchesSignature(mime, bytes([...JPEG]))).toBe(false);
    expect(matchesSignature(mime, bytes([...PNG]))).toBe(false);
  });
  // DEFECT (reported): SIGNATURES is a plain object, so an inherited key resolves to Object.prototype members and `.some` throws a TypeError instead of returning false.
  // Not reachable through the policy (its MIME regex needs a slash), but the contract says an unknown content type is false. `it.fails` flips when it is fixed.
  it('does not match inherited object keys as content types', () => {
    for (const m of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) expect(matchesSignature(m, bytes([...PDF]))).toBe(false);
  });
  it('honours the view window of a Uint8Array (byteOffset)', () => {
    const backing = Uint8Array.from([0x00, ...PDF, 1, 2, 3]);
    expect(matchesSignature('application/pdf', backing.subarray(1))).toBe(true);
    expect(matchesSignature('application/pdf', backing)).toBe(false);
  });
});
