// Restricted Markdown-subset renderer and the output allow-list verifier. Zero dependencies, linear-time scanning.
//
// Safety model:
//  1. Input is parsed into an AST; HTML is generated ONLY from that AST with every text node escaped (no raw pass-through).
//  2. Variable values never enter the parser: the template renderer puts placeholders (private-use sentinels) in the string
//     and the values are substituted into the AST output afterwards, as escaped text or as validated link destinations.
//  3. assertSafeHtml re-tokenizes the generated HTML against an allow-list (defense in depth); it runs on every render.
import { ContentError, templateError } from './errors';
import { SENTINEL_CLOSE, SENTINEL_OPEN } from './format';

export const ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'code', 'a', 'ul', 'ol', 'li', 'blockquote', 'h2', 'h3', 'h4'] as const;
const ALLOWED_TAG_SET: ReadonlySet<string> = new Set(ALLOWED_TAGS);
export const EXTERNAL_LINK_REL = 'noopener noreferrer nofollow';
export const MAX_LINK_LENGTH = 2048;
const MAX_NESTING = 32;
const MAX_HTML_DEPTH = 100;

// ---------------------------------------------------------------- link destinations
const DEST_CHARS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%|^{}]+$/;
const SCHEMES = ['https://', 'http://', 'mailto:', 'tel:'];

/**
 * Allow-list check of a FINAL link destination: http(s) absolute URL, mailto:, tel:, or a root-relative path starting with a single '/'.
 * Everything else (other schemes in any case/encoding, protocol-relative, backslashes, whitespace, control or non-ASCII characters) is rejected.
 * Returns the destination unchanged when it is acceptable, otherwise null.
 */
export function checkLinkDestination(destination: string): string | null {
  if (destination.length === 0 || destination.length > MAX_LINK_LENGTH || !DEST_CHARS.test(destination)) return null;
  const lower = destination.toLowerCase();
  if (destination.startsWith('/')) return destination.startsWith('//') ? null : destination;
  if (lower.startsWith('https://') || lower.startsWith('http://')) {
    try {
      const url = new URL(destination);
      return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== '' && url.username === '' && url.password === '' ? destination : null;
    } catch {
      return null;
    }
  }
  if (lower.startsWith('mailto:') || lower.startsWith('tel:')) return destination.length > (lower.startsWith('tel:') ? 4 : 7) ? destination : null;
  return null;
}

function isAbsoluteHttp(destination: string): boolean {
  return /^https?:\/\//i.test(destination);
}

/** A destination whose leading literal text is still consistent with an allowed form (full check happens once the variables are known). */
function plausibleDestinationPrefix(prefix: string): boolean {
  if (prefix === '') return true;
  const lower = prefix.toLowerCase();
  if (prefix.startsWith('/')) return !prefix.startsWith('//');
  return SCHEMES.some((s) => s.startsWith(lower) || lower.startsWith(s));
}

// ---------------------------------------------------------------- AST
export type DestinationPart = string | number;
export type InlineNode =
  | { t: 'text'; v: string }
  | { t: 'var'; i: number }
  | { t: 'br' }
  | { t: 'strong' | 'em' | 'code'; c: InlineNode[] }
  | { t: 'link'; c: InlineNode[]; dest: DestinationPart[] };
export type BlockNode =
  | { t: 'p'; c: InlineNode[] }
  | { t: 'h'; level: 2 | 3 | 4; c: InlineNode[] }
  | { t: 'ul' | 'ol'; items: InlineNode[][] }
  | { t: 'quote'; paragraphs: InlineNode[][] };
export type MarkupDocument = { kind: 'inline'; content: InlineNode[] } | { kind: 'blocks'; blocks: BlockNode[] };

export interface ParseMarkupOptions {
  /** Inline-only documents (RICH_TEXT) have no blocks; every newline is a line break. */
  inlineOnly?: boolean;
  /** Number of placeholders (sentinel tokens) the source may reference; any other sentinel is rejected. */
  placeholderCount?: number;
}

const ESCAPABLE = new Set([...'\\`*_[]()#+-.!><|~{}&"\'']);
const isSpace = (c: string): boolean => /\s/.test(c);
const isWordChar = (c: string): boolean => c === SENTINEL_OPEN || c === SENTINEL_CLOSE || /[\p{L}\p{N}]/u.test(c);

function unsafeLink(message: string): ContentError {
  return templateError('UNSAFE_LINK', message);
}

function parseDestination(raw: string, placeholderCount: number): DestinationPart[] {
  const parts: DestinationPart[] = [];
  let literal = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === SENTINEL_OPEN) {
      const end = raw.indexOf(SENTINEL_CLOSE, i + 1);
      const idx = end === -1 ? NaN : Number(raw.slice(i + 1, end));
      if (!Number.isInteger(idx) || idx < 0 || idx >= placeholderCount)
        throw templateError('FORBIDDEN_CHARACTER', 'Reserved placeholder character in markup source');
      if (literal) parts.push(literal);
      literal = '';
      parts.push(idx);
      i = end;
    } else if (c === SENTINEL_CLOSE) {
      throw templateError('FORBIDDEN_CHARACTER', 'Reserved placeholder character in markup source');
    } else {
      literal += c;
    }
  }
  if (literal) parts.push(literal);
  const hasVariable = parts.some((p) => typeof p === 'number');
  if (!hasVariable) {
    if (checkLinkDestination(raw) === null) throw unsafeLink('Link destination is not allowed (use https:, http:, mailto:, tel: or a root-relative path)');
  } else {
    const first = parts[0];
    if (typeof first === 'string' && !plausibleDestinationPrefix(first))
      throw unsafeLink('Link destination is not allowed (use https:, http:, mailto:, tel: or a root-relative path)');
    if (raw.length > MAX_LINK_LENGTH * 4) throw unsafeLink('Link destination is too long');
  }
  return parts;
}

interface DelimiterEntry {
  marker: '**' | '*' | '_';
  idx: number;
}
interface BracketEntry {
  idx: number;
}

/** Parses inline markup. Linear: every scan either consumes input or is bounded; unmatched delimiters stay literal text. */
function parseInline(s: string, placeholderCount: number): InlineNode[] {
  const out: InlineNode[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf) {
      out.push({ t: 'text', v: buf });
      buf = '';
    }
  };
  const emphasis: DelimiterEntry[] = [];
  const counts = { '**': 0, '*': 0, _: 0 };
  const brackets: BracketEntry[] = [];
  const lastBacktick = s.lastIndexOf('`');
  let nextParenAt = -2; // cache of indexOf(')') so repeated failed link attempts stay linear

  const placeholder = (at: number): { index: number; end: number } => {
    const end = s.indexOf(SENTINEL_CLOSE, at + 1);
    const index = end === -1 ? NaN : Number(s.slice(at + 1, end));
    if (!/^\d+$/.test(end === -1 ? '' : s.slice(at + 1, end)) || !Number.isInteger(index) || index >= placeholderCount) {
      throw templateError('FORBIDDEN_CHARACTER', 'Reserved placeholder character in markup source');
    }
    return { index, end };
  };

  const dropBracketsAfter = (idx: number): void => {
    while (brackets.length > 0 && brackets[brackets.length - 1]!.idx > idx) brackets.pop();
  };

  const processRun = (marker: '*' | '_', run: number, prev: string | undefined, next: string | undefined): string => {
    const canOpenBase = next !== undefined && !isSpace(next);
    const canCloseBase = prev !== undefined && !isSpace(prev);
    const canOpen = marker === '_' ? canOpenBase && (prev === undefined || !isWordChar(prev)) : canOpenBase;
    const canClose = marker === '_' ? canCloseBase && (next === undefined || !isWordChar(next)) : canCloseBase;
    let rem = run;
    if (marker === '_' && run > 1) return marker.repeat(run);
    if (canClose) {
      while (rem > 0) {
        const usable = marker === '_' ? counts._ > 0 : (counts['*'] > 0 && rem >= 1) || (counts['**'] > 0 && rem >= 2);
        if (!usable) break;
        let si = emphasis.length - 1;
        for (; si >= 0; si--) {
          const e = emphasis[si]!;
          if (marker === '_' ? e.marker === '_' : e.marker === '*' || (e.marker === '**' && rem >= 2)) break;
        }
        // Everything above the matched opener stays literal text.
        for (let k = emphasis.length - 1; k > si; k--) counts[emphasis[k]!.marker]--;
        const entry = emphasis[si]!;
        emphasis.length = si;
        counts[entry.marker]--;
        flush();
        const children = out.splice(entry.idx + 1);
        if (children.length === 0) {
          out[entry.idx] = { t: 'text', v: entry.marker + entry.marker };
        } else {
          out[entry.idx] = { t: entry.marker === '**' ? 'strong' : 'em', c: children };
        }
        dropBracketsAfter(entry.idx);
        rem -= entry.marker.length;
      }
    }
    let literal = '';
    if (rem > 0 && canOpen) {
      while (rem > 0 && emphasis.length < MAX_NESTING) {
        const m: '**' | '*' | '_' = marker === '_' ? '_' : rem >= 2 ? '**' : '*';
        flush();
        out.push({ t: 'text', v: m });
        emphasis.push({ marker: m, idx: out.length - 1 });
        counts[m]++;
        rem -= m.length;
      }
    }
    if (rem > 0) literal = marker.repeat(rem);
    return literal;
  };

  for (let i = 0; i < s.length;) {
    const c = s[i]!;
    if (c === '\\') {
      const n = s[i + 1];
      if (n !== undefined && ESCAPABLE.has(n)) {
        buf += n;
        i += 2;
      } else {
        buf += c;
        i++;
      }
    } else if (c === '\n') {
      flush();
      out.push({ t: 'br' });
      i++;
    } else if (c === SENTINEL_OPEN) {
      const p = placeholder(i);
      flush();
      out.push({ t: 'var', i: p.index });
      i = p.end + 1;
    } else if (c === SENTINEL_CLOSE) {
      throw templateError('FORBIDDEN_CHARACTER', 'Reserved placeholder character in markup source');
    } else if (c === '`') {
      const j = i < lastBacktick ? s.indexOf('`', i + 1) : -1;
      if (j === -1 || j === i + 1) {
        buf += c;
        i++;
      } else {
        flush();
        const inner: InlineNode[] = [];
        let text = '';
        for (let k = i + 1; k < j; k++) {
          const ch = s[k]!;
          if (ch === SENTINEL_OPEN) {
            const p = placeholder(k);
            if (text) inner.push({ t: 'text', v: text });
            text = '';
            inner.push({ t: 'var', i: p.index });
            k = p.end;
          } else if (ch === SENTINEL_CLOSE) {
            throw templateError('FORBIDDEN_CHARACTER', 'Reserved placeholder character in markup source');
          } else {
            text += ch === '\n' ? ' ' : ch;
          }
        }
        if (text) inner.push({ t: 'text', v: text });
        out.push({ t: 'code', c: inner });
        i = j + 1;
      }
    } else if (c === '*' || c === '_') {
      let k = i;
      while (s[k] === c) k++;
      const literal = processRun(c, k - i, i > 0 ? s[i - 1] : undefined, s[k]); // (flushes buf: do not fold into `buf +=`)
      buf += literal;
      i = k;
    } else if (c === '[') {
      if (brackets.length < MAX_NESTING) {
        flush();
        out.push({ t: 'text', v: '[' });
        brackets.push({ idx: out.length - 1 });
      } else {
        buf += c;
      }
      i++;
    } else if (c === ']') {
      let linked = false;
      if (brackets.length > 0 && s[i + 1] === '(') {
        if (nextParenAt !== -1 && nextParenAt < i + 2) nextParenAt = s.indexOf(')', i + 2);
        const close = nextParenAt;
        if (close !== -1 && close - (i + 2) <= MAX_LINK_LENGTH * 4) {
          const dest = parseDestination(s.slice(i + 2, close), placeholderCount); // throws UNSAFE_LINK
          const b = brackets.pop()!;
          flush();
          for (let k = emphasis.length - 1; k >= 0 && emphasis[k]!.idx > b.idx; k--) counts[emphasis.pop()!.marker]--;
          const children = out.splice(b.idx + 1);
          if (children.length === 0) {
            // An empty link text is not a link: keep it literal (placeholders inside the destination are dropped).
            out.push({ t: 'text', v: `](${s.slice(i + 2, close)})`.replace(/\uE000\d+\uE001/g, '') });
          } else {
            out[b.idx] = { t: 'link', c: children, dest };
            brackets.length = 0; // links never nest
          }
          i = close + 1;
          linked = true;
        }
      }
      if (!linked) {
        buf += c;
        i++;
      }
    } else {
      buf += c;
      i++;
    }
  }
  flush();
  return out;
}

function parseBlocks(source: string, placeholderCount: number): BlockNode[] {
  const lines = source.split('\n').map((l) => l.trim());
  const blocks: BlockNode[] = [];
  let para: string[] = [];
  const inline = (text: string): InlineNode[] => parseInline(text, placeholderCount);
  const flushPara = (): void => {
    if (para.length) blocks.push({ t: 'p', c: inline(para.join('\n')) });
    para = [];
  };
  const bullet = (l: string): boolean => l.startsWith('- ') || l.startsWith('* ');
  const ordered = (l: string): number => {
    let d = 0;
    while (d < l.length && d < 10 && l.charCodeAt(d) >= 48 && l.charCodeAt(d) <= 57) d++;
    return d > 0 && d <= 9 && l[d] === '.' && l[d + 1] === ' ' ? d + 2 : 0;
  };
  const headingLevel = (l: string): number => {
    let h = 0;
    while (l[h] === '#') h++;
    return h >= 1 && h <= 3 && l[h] === ' ' && l.slice(h + 1).trim() !== '' ? h : 0;
  };

  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (line === '') {
      flushPara();
      i++;
    } else if (headingLevel(line)) {
      flushPara();
      const h = headingLevel(line);
      blocks.push({ t: 'h', level: (h + 1) as 2 | 3 | 4, c: inline(line.slice(h + 1).trim()) });
      i++;
    } else if (line.startsWith('>')) {
      flushPara();
      const paragraphs: InlineNode[][] = [];
      let current: string[] = [];
      const end = (): void => {
        if (current.length) paragraphs.push(inline(current.join('\n')));
        current = [];
      };
      while (i < lines.length && lines[i]!.startsWith('>')) {
        const inner = lines[i]!.slice(1).trim();
        if (inner === '') end();
        else current.push(inner);
        i++;
      }
      end();
      blocks.push({ t: 'quote', paragraphs });
    } else if (bullet(line)) {
      flushPara();
      const items: InlineNode[][] = [];
      while (i < lines.length && bullet(lines[i]!)) items.push(inline(lines[i++]!.slice(2).trim()));
      blocks.push({ t: 'ul', items });
    } else if (ordered(line)) {
      flushPara();
      const items: InlineNode[][] = [];
      while (i < lines.length && ordered(lines[i]!)) {
        items.push(inline(lines[i]!.slice(ordered(lines[i]!)).trim()));
        i++;
      }
      blocks.push({ t: 'ol', items });
    } else {
      para.push(line);
      i++;
    }
  }
  flushPara();
  return blocks;
}

/**
 * Parses the Markdown subset. Throws TEMPLATE_ERROR reason UNSAFE_LINK for any link whose destination is not allow-listed.
 * Raw HTML is not recognized: it is plain text and will be escaped.
 */
export function parseMarkup(source: string, options: ParseMarkupOptions = {}): MarkupDocument {
  const normalized = source.replace(/\r\n?/g, '\n');
  const placeholderCount = options.placeholderCount ?? 0;
  if (options.inlineOnly) return { kind: 'inline', content: parseInline(normalized.trim(), placeholderCount) };
  return { kind: 'blocks', blocks: parseBlocks(normalized, placeholderCount) };
}

// ---------------------------------------------------------------- HTML generation (AST only)
export function escapeHtml(text: string): string {
  let out = '';
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    let rep: string;
    switch (text.charCodeAt(i)) {
      case 38:
        rep = '&amp;';
        break;
      case 60:
        rep = '&lt;';
        break;
      case 62:
        rep = '&gt;';
        break;
      case 34:
        rep = '&quot;';
        break;
      case 39:
        rep = '&#39;';
        break;
      default:
        continue;
    }
    out += text.slice(last, i) + rep;
    last = i + 1;
  }
  return out + text.slice(last);
}

export interface RenderMarkupOptions {
  /** Formatted variable values by placeholder index. Inserted as escaped text, or as link destinations after validation. */
  values?: readonly string[];
  /** Variable names by placeholder index (only used in error details). */
  variableNames?: readonly string[];
}

function renderInline(nodes: readonly InlineNode[], o: RenderMarkupOptions, out: string[]): void {
  const values = o.values ?? [];
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
        out.push(escapeHtml(n.v));
        break;
      case 'var':
        out.push(escapeHtml(values[n.i] ?? ''));
        break;
      case 'br':
        out.push('<br>');
        break;
      case 'strong':
      case 'em':
      case 'code':
        out.push(`<${n.t}>`);
        renderInline(n.c, o, out);
        out.push(`</${n.t}>`);
        break;
      case 'link': {
        const used = n.dest.filter((p): p is number => typeof p === 'number');
        const dest = n.dest.map((p) => (typeof p === 'number' ? (values[p] ?? '') : p)).join('');
        const checked = checkLinkDestination(dest);
        if (checked === null) {
          if (used.length > 0) {
            throw templateError('INVALID_VARIABLE_VALUE', 'A variable produced an unsafe link destination', {
              context: 'LINK_DESTINATION',
              variables: used.map((i) => o.variableNames?.[i]).filter((v) => v !== undefined),
            });
          }
          throw unsafeLink('Link destination is not allowed');
        }
        out.push(`<a href="${escapeHtml(checked)}"${isAbsoluteHttp(checked) ? ` rel="${EXTERNAL_LINK_REL}"` : ''}>`);
        renderInline(n.c, o, out);
        out.push('</a>');
        break;
      }
    }
  }
}

/** Renders a parsed document to HTML containing only allow-listed tags and attributes. */
export function renderMarkupDocument(doc: MarkupDocument, options: RenderMarkupOptions = {}): string {
  const out: string[] = [];
  if (doc.kind === 'inline') {
    renderInline(doc.content, options, out);
  } else {
    for (const b of doc.blocks) {
      switch (b.t) {
        case 'p':
          out.push('<p>');
          renderInline(b.c, options, out);
          out.push('</p>');
          break;
        case 'h':
          out.push(`<h${b.level}>`);
          renderInline(b.c, options, out);
          out.push(`</h${b.level}>`);
          break;
        case 'ul':
        case 'ol':
          out.push(`<${b.t}>`);
          for (const item of b.items) {
            out.push('<li>');
            renderInline(item, options, out);
            out.push('</li>');
          }
          out.push(`</${b.t}>`);
          break;
        case 'quote':
          out.push('<blockquote>');
          for (const p of b.paragraphs) {
            out.push('<p>');
            renderInline(p, options, out);
            out.push('</p>');
          }
          out.push('</blockquote>');
          break;
      }
    }
  }
  const html = out.join('');
  assertSafeHtml(html);
  return html;
}

/** Convenience: parse and render markup that has no placeholders (for example static help text). The output is verified by assertSafeHtml. */
export function renderMarkup(source: string, options: Pick<ParseMarkupOptions, 'inlineOnly'> = {}): string {
  return renderMarkupDocument(parseMarkup(source, { inlineOnly: options.inlineOnly }));
}

// ---------------------------------------------------------------- output verifier
function unsafeHtml(message: string, position: number): ContentError {
  return templateError('UNSAFE_HTML', message, { position });
}

const ENTITY = /^&(amp|lt|gt|quot|#39);/;

function decodeAttribute(value: string, position: number): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '&') {
      const m = ENTITY.exec(value.slice(i, i + 7));
      if (!m) throw unsafeHtml('Unescaped ampersand in attribute value', position);
      out += { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[m[1] as 'amp'];
      i += m[0].length - 1;
    } else {
      out += value[i];
    }
  }
  return out;
}

/**
 * Defense-in-depth verifier for generated HTML. Tokenizes the output and throws ContentError(TEMPLATE_ERROR, reason UNSAFE_HTML) when it contains
 * anything outside the allow-list: tags other than p br strong em code a ul ol li blockquote h2 h3 h4; attributes other than href/rel on a;
 * a href that is not an allow-listed destination; a rel other than the expected value; unbalanced or too deeply nested tags; raw '<' or '>' in
 * text; unescaped ampersands; control characters or placeholder sentinels.
 */
export function assertSafeHtml(html: string): void {
  const stack: string[] = [];
  let i = 0;
  while (i < html.length) {
    const c = html[i]!;
    const code = html.charCodeAt(i);
    if (code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f || code === 0xe000 || code === 0xe001) {
      throw unsafeHtml('Control character or reserved character in output', i);
    }
    if (c === '>') throw unsafeHtml("Raw '>' in text", i);
    if (c === '&') {
      const m = ENTITY.exec(html.slice(i, i + 7));
      if (!m) throw unsafeHtml('Unescaped ampersand in text', i);
      i += m[0].length;
      continue;
    }
    if (c !== '<') {
      i++;
      continue;
    }
    // tag
    const start = i;
    i++;
    const closing = html[i] === '/';
    if (closing) i++;
    let name = '';
    while (i < html.length && /[a-z0-9]/.test(html[i]!)) name += html[i++];
    if (!ALLOWED_TAG_SET.has(name)) throw unsafeHtml('Tag is not allow-listed', start);
    if (closing) {
      if (html[i] !== '>') throw unsafeHtml('Malformed closing tag', start);
      i++;
      if (name === 'br' || stack.pop() !== name) throw unsafeHtml('Unbalanced closing tag', start);
      continue;
    }
    let sawHref: string | null = null;
    let sawRel: string | null = null;
    while (html[i] === ' ') {
      i++;
      let attr = '';
      while (i < html.length && /[a-z]/.test(html[i]!)) attr += html[i++];
      if (name !== 'a' || (attr !== 'href' && attr !== 'rel')) throw unsafeHtml('Attribute is not allow-listed', start);
      if (html[i] !== '=' || html[i + 1] !== '"') throw unsafeHtml('Malformed attribute', start);
      const valueStart = i + 2;
      const valueEnd = html.indexOf('"', valueStart);
      if (valueEnd === -1) throw unsafeHtml('Unterminated attribute', start);
      const raw = html.slice(valueStart, valueEnd);
      if (raw.includes('<') || raw.includes('>')) throw unsafeHtml('Raw angle bracket in attribute', start);
      const value = decodeAttribute(raw, start);
      if (attr === 'href') {
        if (sawHref !== null) throw unsafeHtml('Duplicate attribute', start);
        sawHref = value;
      } else {
        if (sawRel !== null) throw unsafeHtml('Duplicate attribute', start);
        sawRel = value;
      }
      i = valueEnd + 1;
    }
    if (html[i] !== '>') throw unsafeHtml('Malformed tag', start);
    i++;
    if (name === 'a') {
      if (sawHref === null || checkLinkDestination(sawHref) === null) throw unsafeHtml('Link destination is not allow-listed', start);
      if (isAbsoluteHttp(sawHref) ? sawRel !== EXTERNAL_LINK_REL : sawRel !== null) throw unsafeHtml('Unexpected rel attribute', start);
    }
    if (name !== 'br') {
      stack.push(name);
      if (stack.length > MAX_HTML_DEPTH) throw unsafeHtml('Markup nested too deeply', start);
    }
  }
  if (stack.length > 0) throw unsafeHtml('Unclosed tag', html.length);
}
