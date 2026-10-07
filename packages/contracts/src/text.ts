import { z } from 'zod';

/**
 * Free text typed by an administrator. Reject characters that can make labels misleading or cannot be stored as UTF-8,
 * as well as values that are blank once whitespace is ignored.
 */
const FORBIDDEN_TEXT_CHARACTER =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const BLANK_TEXT = /^[\s\u200B\u2060\u180E]*$/;

/** Whether a string holds a control, bidirectional-override or unpaired surrogate character (shared by administrator text and address values). */
export const containsForbiddenText = (v: string): boolean => FORBIDDEN_TEXT_CHARACTER.test(v);

export const adminText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !FORBIDDEN_TEXT_CHARACTER.test(v), { message: 'must not contain control, bidirectional-override or unpaired surrogate characters' })
    .refine((v) => !BLANK_TEXT.test(v), { message: 'must not be blank' });
