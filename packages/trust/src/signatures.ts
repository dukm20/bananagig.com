// File-signature ("magic byte") checks for verification documents (TRUST-001). A client-declared content type is never trusted: the first bytes of the stored object must
// match the declared type, so a renamed executable or an HTML page cannot pass as a PDF or an image. A content type the configuration allows but this table does not know is
// refused (fail closed): adding a format means adding its signature here, with a test.
const SIGNATURES: Readonly<Record<string, readonly (readonly number[])[]>> = {
  'application/pdf': [[0x25, 0x50, 0x44, 0x46, 0x2d]], // %PDF-
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
};

/** Content types this build can verify. */
export const SNIFFABLE_MIME_TYPES = Object.keys(SIGNATURES);

/** Whether the bytes start with a signature of the declared content type. false for an unknown content type. */
export function matchesSignature(declaredMimeType: string, bytes: Uint8Array): boolean {
  // an own key only: an inherited name such as `constructor` is not a content type
  const signatures = Object.hasOwn(SIGNATURES, declaredMimeType) ? SIGNATURES[declaredMimeType] : undefined;
  if (!signatures) return false;
  return signatures.some((sig) => bytes.byteLength >= sig.length && sig.every((b, i) => bytes[i] === b));
}
