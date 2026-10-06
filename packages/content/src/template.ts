// The restricted template language: literal text, {name} placeholders, {{ and }} literal braces and ONE construct,
// {name, plural, one {..} other {..}}. No expressions, helpers, includes or code of any kind: the source is parsed into a small AST and
// rendered by pure functions; values are formatted by type and are never re-interpreted.
import { MARKUP_CONTENT_TYPES, INLINE_ONLY_CONTENT_TYPES, type ContentType, type VariableType } from '@bananagig/contracts';
import { ContentError, templateError } from './errors';
import {
  SENTINEL_CLOSE,
  SENTINEL_OPEN,
  findForbiddenCharacter,
  formatVariable,
  formattingLocale,
  pluralCategory,
  validateTimeZone,
  PLURAL_CATEGORIES,
  type PluralCategory,
} from './format';
import { assertSafeHtml, parseMarkup, renderMarkupDocument } from './markup';

export const MAX_TEMPLATE_LENGTH = 200_000;
export const MAX_PLACEHOLDERS = 200;
export const MAX_SINGLE_LINE_LENGTH = 500;
const MAX_VARIABLE_NAME_LENGTH = 60;
/** Types whose rendering is one line (no CR/LF may ever appear: header injection). */
export const SINGLE_LINE_CONTENT_TYPES: readonly ContentType[] = ['UI_LABEL', 'EMAIL_SUBJECT', 'PUSH_TITLE'];

export type { PluralCategory };

// ---------------------------------------------------------------- AST
export type BranchNode = { kind: 'text'; value: string } | { kind: 'variable'; name: string; position: number } | { kind: 'count' };
export type TemplateNode = BranchNode | { kind: 'plural'; id: number; name: string; position: number; branches: Partial<Record<PluralCategory, BranchNode[]>> };
export interface ParsedTemplate {
  nodes: TemplateNode[];
  /** Placeholders in the source (variables, plural constructs and '#'); limited to MAX_PLACEHOLDERS. */
  placeholders: number;
}

/** Variable definition as needed for template work (VariableDefinition and VariableDefinitionDto both fit). */
export interface TemplateVariable {
  name: string;
  type: VariableType;
  required?: boolean;
  example?: unknown;
}

function lineColumn(source: string, position: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < position && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, column: position - last };
}

function syntaxError(source: string, position: number, message: string): ContentError {
  const { line, column } = lineColumn(source, position);
  return templateError('SYNTAX', `Template syntax error at line ${line}, column ${column}: ${message}`, { position, line, column });
}

const isNameStart = (c: string | undefined): boolean => c !== undefined && c >= 'a' && c <= 'z';
const isNameChar = (c: string | undefined): boolean => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_');
const isWs = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

const parseCache = new Map<string, ParsedTemplate>();

/** Parses template source. Throws TEMPLATE_ERROR (details.reason SYNTAX | FORBIDDEN_CHARACTER | LIMIT, with position). */
export function parseTemplate(source: string): ParsedTemplate {
  if (typeof source !== 'string') throw templateError('SYNTAX', 'Template source must be a string', { position: 0 });
  if (source.length > MAX_TEMPLATE_LENGTH)
    throw templateError('LIMIT', `Template is longer than ${MAX_TEMPLATE_LENGTH} characters`, { limit: MAX_TEMPLATE_LENGTH });
  const hit = parseCache.get(source);
  if (hit) return hit;
  const bad = findForbiddenCharacter(source);
  if (bad !== -1) {
    const { line, column } = lineColumn(source, bad);
    throw templateError('FORBIDDEN_CHARACTER', `Template contains a forbidden control or reserved character at line ${line}, column ${column}`, {
      position: bad,
      line,
      column,
    });
  }

  let i = 0;
  let placeholders = 0;
  let pluralId = 0;
  const countPlaceholder = (at: number): void => {
    if (++placeholders > MAX_PLACEHOLDERS)
      throw templateError('LIMIT', `Template has more than ${MAX_PLACEHOLDERS} placeholders`, { limit: MAX_PLACEHOLDERS, position: at });
  };
  const skipWs = (): void => {
    while (isWs(source[i])) i++;
  };
  const readName = (): string => {
    const start = i;
    if (!isNameStart(source[i])) throw syntaxError(source, i, 'expected a variable name (lower-case letters, digits and underscores, starting with a letter)');
    while (isNameChar(source[i])) i++;
    if (i - start > MAX_VARIABLE_NAME_LENGTH) throw syntaxError(source, start, `variable name is longer than ${MAX_VARIABLE_NAME_LENGTH} characters`);
    return source.slice(start, i);
  };
  const expect = (ch: string, what: string): void => {
    if (source[i] !== ch) throw syntaxError(source, i, `expected ${what}`);
    i++;
  };
  const expectKeyword = (word: string): void => {
    if (!source.startsWith(word, i) || isNameChar(source[i + word.length])) throw syntaxError(source, i, `expected '${word}'`);
    i += word.length;
  };

  const parseBranch = (): BranchNode[] => {
    // positioned just after the opening '{' of the branch
    const nodes: BranchNode[] = [];
    let text = '';
    const flush = (): void => {
      if (text) nodes.push({ kind: 'text', value: text });
      text = '';
    };
    for (;;) {
      if (i >= source.length) throw syntaxError(source, i, 'unterminated plural branch');
      const c = source[i]!;
      if (c === '}') {
        i++;
        flush();
        return nodes;
      }
      if (c === '{') {
        if (source[i + 1] === '{') {
          text += '{';
          i += 2;
          continue;
        }
        const position = i;
        i++;
        const name = readName();
        if (source[i] !== '}') throw syntaxError(source, i, 'only simple {name} placeholders are allowed inside a plural branch (no nesting)');
        i++;
        countPlaceholder(position);
        flush();
        nodes.push({ kind: 'variable', name, position });
      } else if (c === '#') {
        countPlaceholder(i);
        flush();
        nodes.push({ kind: 'count' });
        i++;
      } else {
        text += c;
        i++;
      }
    }
  };

  const parsePlaceholder = (): TemplateNode => {
    const position = i;
    i++; // '{'
    const leadingWs = isWs(source[i]);
    skipWs();
    const name = readName();
    if (source[i] === '}') {
      if (leadingWs) throw syntaxError(source, position + 1, 'whitespace is only allowed around plural keywords, not inside a simple placeholder');
      i++;
      countPlaceholder(position);
      return { kind: 'variable', name, position };
    }
    skipWs();
    expect(',', "'}' or ',' after the variable name (whitespace is only allowed around plural keywords)");
    skipWs();
    expectKeyword('plural');
    skipWs();
    expect(',', "',' after 'plural'");
    countPlaceholder(position);
    const branches: Partial<Record<PluralCategory, BranchNode[]>> = {};
    for (;;) {
      skipWs();
      if (source[i] === '}') {
        i++;
        break;
      }
      const catStart = i;
      while (isNameChar(source[i])) i++;
      const category = source.slice(catStart, i) as PluralCategory;
      if (!PLURAL_CATEGORIES.includes(category)) throw syntaxError(source, catStart, 'expected a plural category (zero, one, two, few, many, other)');
      if (branches[category]) throw syntaxError(source, catStart, `duplicate plural category '${category}'`);
      skipWs();
      expect('{', "'{' to open the plural branch");
      branches[category] = parseBranch();
    }
    if (!branches.other) throw syntaxError(source, i - 1, "a plural construct requires an 'other' branch");
    return { kind: 'plural', id: pluralId++, name, position, branches };
  };

  const nodes: TemplateNode[] = [];
  let text = '';
  const flush = (): void => {
    if (text) nodes.push({ kind: 'text', value: text });
    text = '';
  };
  while (i < source.length) {
    const c = source[i]!;
    if (c === '{') {
      if (source[i + 1] === '{') {
        text += '{';
        i += 2;
      } else {
        flush();
        nodes.push(parsePlaceholder());
      }
    } else if (c === '}') {
      if (source[i + 1] === '}') {
        text += '}';
        i += 2;
      } else {
        throw syntaxError(source, i, "unmatched '}' (write '}}' for a literal brace)");
      }
    } else {
      text += c;
      i++;
    }
  }
  flush();
  const parsed: ParsedTemplate = { nodes, placeholders };
  if (source.length <= 50_000) {
    if (parseCache.size >= 256) parseCache.clear();
    parseCache.set(source, parsed);
  }
  return parsed;
}

/** Names of the variables a template references, in order of first appearance. Accepts source or an already parsed template. */
export function referencedVariables(template: string | ParsedTemplate): string[] {
  const parsed = typeof template === 'string' ? parseTemplate(template) : template;
  const seen = new Set<string>();
  for (const node of parsed.nodes) {
    if (node.kind === 'variable') seen.add(node.name);
    else if (node.kind === 'plural') {
      seen.add(node.name);
      for (const cat of PLURAL_CATEGORIES) for (const b of node.branches[cat] ?? []) if (b.kind === 'variable') seen.add(b.name);
    }
  }
  return [...seen];
}

// ---------------------------------------------------------------- rendering
export const isMarkupContentType = (t: ContentType): boolean => MARKUP_CONTENT_TYPES.includes(t);
export const isSingleLineContentType = (t: ContentType): boolean => SINGLE_LINE_CONTENT_TYPES.includes(t);

export interface RenderTemplateInput {
  source: string;
  contentType: ContentType;
  /** The entry's variable definitions. */
  variables: readonly TemplateVariable[];
  /** Values by variable name, in the canonical encoding of each variable type. */
  values?: Readonly<Record<string, unknown>>;
  /** The locale the copy is rendered in (formatting and plural rules). */
  locale: string;
  timeZone?: string;
}
export interface RenderedTemplate {
  format: 'text' | 'html';
  value: string;
}

interface Prepared {
  defs: Map<string, TemplateVariable>;
  formatted: Map<string, string>;
  counts: Map<string, number>;
  locale: string;
}

function definitionMap(variables: readonly TemplateVariable[]): Map<string, TemplateVariable> {
  const defs = new Map<string, TemplateVariable>();
  for (const v of variables) if (!defs.has(v.name)) defs.set(v.name, v);
  return defs;
}

function prepare(
  parsed: ParsedTemplate,
  variables: readonly TemplateVariable[],
  values: Readonly<Record<string, unknown>> | undefined,
  locale: string,
  timeZone?: string,
): Prepared {
  const defs = definitionMap(variables);
  const formatted = new Map<string, string>();
  const counts = new Map<string, number>();
  const provided = values ?? {};
  if (typeof provided !== 'object' || provided === null || Array.isArray(provided))
    throw templateError('INVALID_VARIABLE_VALUE', 'Variable values must be an object keyed by variable name');
  if (timeZone !== undefined) validateTimeZone(timeZone);
  for (const key of Object.keys(provided)) {
    const def = defs.get(key);
    if (!def)
      throw templateError('UNKNOWN_VARIABLE', 'A value was provided for a variable the entry does not define', {
        variable: key.slice(0, MAX_VARIABLE_NAME_LENGTH),
      });
    const value = provided[key];
    if (value === undefined || value === null) continue;
    formatted.set(key, formatVariable(def, value, { locale, timeZone }));
    if (def.type === 'COUNT') counts.set(key, value as number); // formatVariable proved it is a non-negative safe integer
  }
  for (const name of referencedVariables(parsed)) {
    const def = defs.get(name);
    if (!def) throw templateError('UNKNOWN_VARIABLE', 'The template references a variable the entry does not define', { variable: name });
    if (!formatted.has(name) && (def.required ?? true))
      throw templateError('MISSING_REQUIRED_VARIABLE', 'A required variable has no value', { variable: name });
  }
  for (const node of parsed.nodes) {
    if (node.kind === 'plural' && defs.get(node.name)!.type !== 'COUNT') {
      throw templateError('PLURAL_REQUIRES_COUNT', 'A plural construct can only use a COUNT variable', { variable: node.name, position: node.position });
    }
  }
  return { defs, formatted, counts, locale };
}

type Emit = { literal: (text: string) => void; variable: (name: string) => void };

/** The categories a plural construct actually has branches for, in canonical order ('other' is always present). */
function availableCategories(node: Extract<TemplateNode, { kind: 'plural' }>): PluralCategory[] {
  return PLURAL_CATEGORIES.filter((c) => node.branches[c] !== undefined);
}

/**
 * Walks the template. With `round` (dry renders only), every plural construct is forced to its round-th available category instead of the one the
 * count selects; a construct with fewer categories reuses its last, so round r over all constructs visits each construct's r-th branch.
 */
function walk(parsed: ParsedTemplate, p: Prepared, emit: Emit, round?: number): void {
  for (const node of parsed.nodes) {
    if (node.kind === 'text') emit.literal(node.value);
    else if (node.kind === 'variable') emit.variable(node.name);
    else if (node.kind === 'plural') {
      const count = p.counts.get(node.name);
      let wanted: PluralCategory;
      if (round !== undefined) {
        const available = availableCategories(node);
        wanted = available[Math.min(round, available.length - 1)]!;
      } else wanted = count === undefined ? 'other' : pluralCategory(p.locale, count);
      const branch = node.branches[wanted] ?? node.branches.other!;
      for (const b of branch) {
        if (b.kind === 'text') emit.literal(b.value);
        else if (b.kind === 'variable') emit.variable(b.name);
        else emit.variable(node.name); // '#': the formatted count
      }
    }
  }
}

/** Whitespace plus every Unicode line terminator (NEL, LS, PS) and C1 control, collapsed to one space in single-line output. */
const SINGLE_LINE_COLLAPSE = /[\s\u0080-\u009f\u2028\u2029]+/g;

function renderPlain(parsed: ParsedTemplate, p: Prepared, singleLine: boolean, round?: number): string {
  let out = '';
  walk(parsed, p, { literal: (t) => (out += t), variable: (n) => (out += p.formatted.get(n) ?? '') }, round);
  if (!singleLine) return out;
  const line = out.replace(SINGLE_LINE_COLLAPSE, ' ').trim();
  // The limit applies to what is rendered, not only to the source: values can add up to MAX_STRING_LENGTH characters each (no copy in details).
  if (line.length > MAX_SINGLE_LINE_LENGTH)
    throw templateError('LIMIT', `Rendered single-line content is longer than ${MAX_SINGLE_LINE_LENGTH} characters`, {
      limit: MAX_SINGLE_LINE_LENGTH,
      rendered: true,
    });
  return line;
}

function renderMarkupFromParsed(parsed: ParsedTemplate, p: Prepared, inlineOnly: boolean, round?: number): string {
  const values: string[] = [];
  const names: string[] = [];
  let intermediate = '';
  walk(
    parsed,
    p,
    {
      literal: (t) => (intermediate += t),
      variable: (n) => {
        intermediate += `${SENTINEL_OPEN}${values.length}${SENTINEL_CLOSE}`;
        values.push(p.formatted.get(n) ?? '');
        names.push(n);
      },
    },
    round,
  );
  const doc = parseMarkup(intermediate, { inlineOnly, placeholderCount: values.length });
  return renderMarkupDocument(doc, { values, variableNames: names });
}

/**
 * Renders a template for a reader. Strict: unknown provided names (UNKNOWN_VARIABLE), a missing required value that the template references
 * (MISSING_REQUIRED_VARIABLE) and a value of the wrong shape (INVALID_VARIABLE_VALUE) are TEMPLATE_ERRORs. An optional variable that is not
 * provided renders as the empty string. Markup types return sanitized HTML (verified with assertSafeHtml); other types return plain text.
 */
export function renderTemplate(input: RenderTemplateInput): RenderedTemplate {
  const locale = formattingLocale(input.locale);
  const parsed = parseTemplate(input.source);
  const prepared = prepare(parsed, input.variables, input.values, locale, input.timeZone);
  if (isMarkupContentType(input.contentType)) {
    return { format: 'html', value: renderMarkupFromParsed(parsed, prepared, INLINE_ONLY_CONTENT_TYPES.includes(input.contentType)) };
  }
  return { format: 'text', value: renderPlain(parsed, prepared, isSingleLineContentType(input.contentType)) };
}

/**
 * Authoring validation: syntax; every referenced variable defined; plural only on COUNT; content-type rules; then a dry render with each
 * variable's `example` (every plural branch is rendered at least once in at most six rounds, single-line output is held to its length limit and markup output is verified by assertSafeHtml).
 * Required variables the body does not reference are allowed. Returns the referenced variable names.
 */
export function validateTemplate(source: string, variables: readonly TemplateVariable[], contentType: ContentType): { variables: string[] } {
  const parsed = parseTemplate(source);
  const defs = definitionMap(variables);
  const referenced = referencedVariables(parsed);
  for (const name of referenced) {
    if (!defs.has(name)) throw templateError('UNKNOWN_VARIABLE', 'The template references a variable the entry does not define', { variable: name });
  }
  for (const node of parsed.nodes) {
    if (node.kind === 'plural' && defs.get(node.name)!.type !== 'COUNT') {
      throw templateError('PLURAL_REQUIRES_COUNT', 'A plural construct can only use a COUNT variable', { variable: node.name, position: node.position });
    }
  }
  if (isSingleLineContentType(contentType)) {
    const newline = source.search(/[\r\n]/);
    if (newline !== -1) throw templateError('CONTENT_TYPE_RULE', `${contentType} content must be a single line`, { position: newline, contentType });
    if (source.length > MAX_SINGLE_LINE_LENGTH)
      throw templateError('CONTENT_TYPE_RULE', `${contentType} content is limited to ${MAX_SINGLE_LINE_LENGTH} characters`, {
        limit: MAX_SINGLE_LINE_LENGTH,
        contentType,
      });
  }

  const examples: Record<string, unknown> = {};
  for (const v of variables) if (v.example !== undefined && v.example !== null) examples[v.name] = v.example;
  try {
    const prepared = prepare(parsed, variables, examples, 'en-US', 'UTC');
    // Round r forces every plural construct to its r-th available category (fewer categories: its last), so every branch of every construct is
    // rendered at least once in at most max(1, most categories of any construct) <= 6 full renders, however many constructs the body has.
    let rounds = 1;
    for (const node of parsed.nodes) if (node.kind === 'plural') rounds = Math.max(rounds, availableCategories(node).length);
    const markup = isMarkupContentType(contentType);
    const inlineOnly = INLINE_ONLY_CONTENT_TYPES.includes(contentType);
    const singleLine = isSingleLineContentType(contentType);
    for (let round = 0; round < rounds; round++) {
      if (markup) assertSafeHtml(renderMarkupFromParsed(parsed, prepared, inlineOnly, round));
      else renderPlain(parsed, prepared, singleLine, round);
    }
  } catch (e) {
    if (e instanceof ContentError && e.code === 'TEMPLATE_ERROR')
      throw new ContentError(e.code, `${e.message} (dry render with the variable examples)`, { ...e.details, phase: 'DRY_RENDER' });
    throw e;
  }
  return { variables: referenced };
}
