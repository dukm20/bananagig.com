import { describe, expect, it, vi } from 'vitest';
import type { ContentType } from '@bananagig/contracts';
import { ContentError } from './errors';
import * as markup from './markup';
import { MAX_PLACEHOLDERS, MAX_TEMPLATE_LENGTH, parseTemplate, referencedVariables, renderTemplate, validateTemplate, type TemplateVariable } from './template';

// Counting hook: every full markup render goes through parseMarkup exactly once, so its call count is the number of full renders.
vi.mock('./markup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./markup')>();
  return { ...actual, parseMarkup: vi.fn(actual.parseMarkup) };
});

const v = (name: string, type: TemplateVariable['type'], example: unknown, required = true): TemplateVariable => ({ name, type, example, required });
const NAME = v('name', 'PERSON_DISPLAY_NAME', 'Ada Lovelace');
const COUNT = v('count', 'COUNT', 3);
const PRICE = v('price', 'MONEY', { amount_minor: 1999, currency: 'USD' });
const WHEN = v('when', 'DATETIME', '2026-03-05T12:00:00Z');
const LINK = v('link', 'URL', 'https://example.com/path');
const NOTE = v('note', 'STRING', 'hello', false);
const ALL = [NAME, COUNT, PRICE, WHEN, LINK, NOTE];

function render(
  source: string,
  values: Record<string, unknown> = {},
  opts: { contentType?: ContentType; locale?: string; variables?: TemplateVariable[]; timeZone?: string } = {},
) {
  return renderTemplate({
    source,
    contentType: opts.contentType ?? 'PLAIN_TEXT',
    variables: opts.variables ?? ALL,
    values,
    locale: opts.locale ?? 'en-US',
    timeZone: opts.timeZone,
  });
}
function failure(fn: () => unknown): ContentError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ContentError);
    return e as ContentError;
  }
  throw new Error('expected a ContentError');
}
const reasonOf = (fn: () => unknown): unknown => {
  const e = failure(fn);
  expect(e.code).toBe('TEMPLATE_ERROR');
  return e.details.reason;
};

describe('parseTemplate', () => {
  it('parses literal text, placeholders and escapes', () => {
    const p = parseTemplate('Hello {name}, {{literal}} done');
    expect(p.nodes.map((n) => n.kind)).toEqual(['text', 'variable', 'text']);
    expect(p.placeholders).toBe(1);
    expect(referencedVariables(p)).toEqual(['name']);
  });
  it('treats {{ and }} as literal braces, including adjacent to placeholders', () => {
    expect(render('{{{name}}}', { name: 'Ada' }).value).toBe('{Ada}');
    expect(render('{{}}', {}).value).toBe('{}');
    expect(render('a {{ b }} c', {}).value).toBe('a { b } c');
  });
  it('parses plural constructs with whitespace around the keywords', () => {
    const p = parseTemplate('{ count , plural , one {# item} other {# items} }');
    expect(p.nodes).toHaveLength(1);
    expect(p.nodes[0]!.kind).toBe('plural');
    expect(parseTemplate('{count,plural,one{# item}other{# items}}').nodes[0]!.kind).toBe('plural');
  });
  it('lists referenced variables once, in order, including plural and branch variables', () => {
    expect(referencedVariables('{name} {count, plural, one {{note} one} other {# {name}}} {name} {price}')).toEqual(['name', 'count', 'note', 'price']);
  });
  it('plain text without placeholders is one text node; empty source is allowed', () => {
    expect(parseTemplate('just text').nodes).toEqual([{ kind: 'text', value: 'just text' }]);
    expect(parseTemplate('').nodes).toEqual([]);
  });
  it('treats # outside plural as literal', () => {
    expect(render('Item #1').value).toBe('Item #1');
  });

  describe('syntax errors report positions', () => {
    const cases: Array<[string, string, number]> = [
      ['unmatched closing brace', 'a } b', 2],
      ['unclosed placeholder', 'a {name', 7],
      ['empty placeholder', 'a {} b', 3],
      ['uppercase name', '{Name}', 1],
      ['name starting with digit', '{1abc}', 1],
      ['name with dash', '{na-me}', 3],
      ['name with dot', '{process.env}', 8],
      ['space inside simple placeholder', '{ name }', 7],
      ['trailing space inside simple placeholder', '{name }', 6],
      ['leading space inside simple placeholder', '{ name}', 1],
      ['inline format argument', '{price, number}', 8],
      ['select is not supported', '{count, select, a {x} other {y}}', 8],
      ['unknown plural category', '{count, plural, some {x} other {y}}', 16],
      ['missing other', '{count, plural, one {x}}', 23],
      ['duplicate category', '{count, plural, one {a} one {b} other {c}}', 24],
      ['nested plural', '{count, plural, one {{count, plural, other {x}}} other {y}}', 27],
      ['expression in branch placeholder', '{count, plural, other {{name.x}}}', 28],
      ['unterminated branch', '{count, plural, other {x', 24],
      ['missing branch brace', '{count, plural, other x}', 22],
      ['empty plural', '{count, plural, }', 16],
      ['plural keyword typo', '{count, plurals, other {x}}', 8],
      ['trailing comma', '{count,}', 7],
    ];
    it.each(cases)('%s', (_label, source, position) => {
      const e = failure(() => parseTemplate(source));
      expect(e.code).toBe('TEMPLATE_ERROR');
      expect(e.details.reason).toBe('SYNTAX');
      expect(e.details.position).toBe(position);
      expect(typeof e.details.line).toBe('number');
      expect(typeof e.details.column).toBe('number');
    });
    it('reports line and column across newlines', () => {
      const e = failure(() => parseTemplate('line one\nline {oops'));
      expect(e.details).toMatchObject({ reason: 'SYNTAX', line: 2 });
    });
  });

  describe('forbidden characters', () => {
    it.each([
      ['NUL', '\u0000'],
      ['BEL', '\u0007'],
      ['vertical tab', '\u000b'],
      ['form feed', '\u000c'],
      ['ESC', '\u001b'],
      ['DEL', '\u007f'],
      ['line separator', ' '],
      ['paragraph separator', ' '],
      ['RLO', '‮'],
      ['LRE', '‪'],
      ['RLI', '⁧'],
      ['PDI', '⁩'],
      ['sentinel open', ''],
      ['sentinel close', ''],
      ['NEL (C1)', '\u0085'],
      ['first C1 control', '\u0080'],
      ['last C1 control', '\u009f'],
      ['DEL', '\u007f'],
    ])('rejects %s with its position', (_label, ch) => {
      const e = failure(() => parseTemplate(`ab${ch}cd`));
      expect(e.details).toMatchObject({ reason: 'FORBIDDEN_CHARACTER', position: 2 });
    });
    it('allows tab, newline and carriage return', () => {
      expect(() => parseTemplate('a\tb\nc\rd')).not.toThrow();
    });
    it('rejects them inside placeholders and branches too', () => {
      expect(reasonOf(() => parseTemplate('{na\u0000me}'))).toBe('FORBIDDEN_CHARACTER');
      expect(reasonOf(() => parseTemplate('{count, plural, other {a‮b}}'))).toBe('FORBIDDEN_CHARACTER');
    });
  });

  describe('limits', () => {
    it('rejects a body over the maximum length and accepts one at the maximum', () => {
      expect(reasonOf(() => parseTemplate('x'.repeat(MAX_TEMPLATE_LENGTH + 1)))).toBe('LIMIT');
      expect(parseTemplate('x'.repeat(MAX_TEMPLATE_LENGTH)).nodes).toHaveLength(1);
    });
    it('rejects more than the maximum number of placeholders and accepts exactly the maximum', () => {
      expect(parseTemplate('{name}'.repeat(MAX_PLACEHOLDERS)).placeholders).toBe(MAX_PLACEHOLDERS);
      expect(reasonOf(() => parseTemplate('{name}'.repeat(MAX_PLACEHOLDERS + 1)))).toBe('LIMIT');
    });
    it('counts # and plural constructs as placeholders', () => {
      expect(reasonOf(() => parseTemplate(`{count, plural, other {${'#'.repeat(MAX_PLACEHOLDERS)}}}`))).toBe('LIMIT');
    });
    it('rejects variable names over 60 characters', () => {
      expect(reasonOf(() => parseTemplate(`{${'a'.repeat(61)}}`))).toBe('SYNTAX');
      expect(() => parseTemplate(`{${'a'.repeat(60)}}`)).not.toThrow();
    });
    it('parses a large body quickly (linear)', () => {
      const started = performance.now();
      parseTemplate('lorem ipsum {{x}} dolor '.repeat(9000).slice(0, MAX_TEMPLATE_LENGTH));
      // Linear parsing takes milliseconds; a quadratic or exponential regression takes tens of seconds. The ceiling is immune to slow shared CI runners.
      expect(performance.now() - started).toBeLessThan(10_000);
    });
  });
});

describe('plural rendering', () => {
  const src = '{count, plural, one {# message} other {# messages}}';
  it('selects English categories and formats #', () => {
    expect(render(src, { count: 1 }).value).toBe('1 message');
    expect(render(src, { count: 0 }).value).toBe('0 messages');
    expect(render(src, { count: 2 }).value).toBe('2 messages');
    expect(render(src, { count: 1234 }).value).toBe('1,234 messages');
  });
  it('uses the locale digit grouping for #', () => {
    expect(render(src, { count: 1234 }, { locale: 'de-DE' }).value).toBe('1.234 messages');
  });
  it('selects Arabic categories (zero, one, two, few, many, other)', () => {
    const ar = '{count, plural, zero {Z} one {O} two {T} few {F} many {M} other {X}}';
    const out = (n: number) => render(ar, { count: n }, { locale: 'ar' }).value;
    expect([0, 1, 2, 5, 11, 100].map(out)).toEqual(['Z', 'O', 'T', 'F', 'M', 'X']);
  });
  it('falls back to other when the selected category has no branch', () => {
    expect(render('{count, plural, other {n=#}}', { count: 1 }).value).toBe('n=1');
    expect(render('{count, plural, one {one} other {other}}', { count: 5 }, { locale: 'ar' }).value).toBe('other');
  });
  it('allows variables inside branches and keeps braces literal with {{', () => {
    expect(render('{count, plural, one {{name} has # item {{ok} other {{name} has # items}}', { count: 1, name: 'Ada' }).value).toBe('Ada has 1 item {ok');
  });
  it('renders the other branch with an empty # when an optional count is absent', () => {
    const vars = [v('count', 'COUNT', 2, false)];
    expect(render('{count, plural, one {# a} other {# b}}', {}, { variables: vars }).value).toBe(' b');
  });
  it('rejects plural on a non-COUNT variable at validation and at render', () => {
    expect(reasonOf(() => validateTemplate('{name, plural, other {x}}', ALL, 'PLAIN_TEXT'))).toBe('PLURAL_REQUIRES_COUNT');
    expect(reasonOf(() => render('{name, plural, other {x}}', { name: 'Ada' }))).toBe('PLURAL_REQUIRES_COUNT');
  });
  it('rejects a non-integer count value', () => {
    expect(reasonOf(() => render(src, { count: 1.5 }))).toBe('INVALID_VARIABLE_VALUE');
    expect(reasonOf(() => render(src, { count: '1' }))).toBe('INVALID_VARIABLE_VALUE');
  });
});

describe('renderTemplate: variables', () => {
  it('formats each type through the variable formatter', () => {
    expect(render('Hi {name}!', { name: ' Ada   Lovelace ' }).value).toBe('Hi Ada Lovelace!');
    expect(render('Total {price}', { price: { amount_minor: 123456, currency: 'USD' } }).value).toBe('Total $1,234.56');
    expect(render('Total {price}', { price: { amount_minor: 123456, currency: 'USD' } }, { locale: 'de-DE' }).value.replace(/\u00a0/g, ' ')).toBe(
      'Total 1.234,56 $',
    );
    expect(render('At {when}', { when: '2026-03-05T23:30:00-05:00' }, { timeZone: 'Asia/Tokyo' }).value.replace(/\u202f/g, ' ')).toBe(
      'At March 6, 2026 at 1:30 PM',
    );
    expect(render('Open {link}', { link: 'https://Example.com' }).value).toBe('Open https://example.com/');
  });
  it('reports a missing required variable that the template references', () => {
    const e = failure(() => render('Hi {name}', {}));
    expect(e.details).toMatchObject({ reason: 'MISSING_REQUIRED_VARIABLE', variable: 'name' });
    expect(reasonOf(() => render('Hi {name}', { name: null }))).toBe('MISSING_REQUIRED_VARIABLE');
    expect(reasonOf(() => render('Hi {name}', { name: undefined }))).toBe('MISSING_REQUIRED_VARIABLE');
  });
  it('allows a required variable the template does not reference', () => {
    expect(render('static', {}).value).toBe('static');
    expect(() => validateTemplate('static', ALL, 'PLAIN_TEXT')).not.toThrow();
  });
  it('rejects a template variable the entry does not define', () => {
    const e = failure(() => render('Hi {nobody}', {}));
    expect(e.details).toMatchObject({ reason: 'UNKNOWN_VARIABLE', variable: 'nobody' });
    expect(reasonOf(() => validateTemplate('Hi {nobody}', ALL, 'PLAIN_TEXT'))).toBe('UNKNOWN_VARIABLE');
    expect(reasonOf(() => validateTemplate('{count, plural, other {{nobody}}}', ALL, 'PLAIN_TEXT'))).toBe('UNKNOWN_VARIABLE');
  });
  it('rejects a provided value for an undefined variable (even when unreferenced)', () => {
    const e = failure(() => render('static', { extra: 'x' }));
    expect(e.details).toMatchObject({ reason: 'UNKNOWN_VARIABLE', variable: 'extra' });
  });
  it('rejects a value of the wrong shape even when the variable is unreferenced', () => {
    expect(reasonOf(() => render('static', { count: 'three' }))).toBe('INVALID_VARIABLE_VALUE');
  });
  it('renders an optional variable that is not provided as empty', () => {
    expect(render('[{note}]', {}).value).toBe('[]');
    expect(render('[{note}]', { note: null }).value).toBe('[]');
    expect(render('[{note}]', { note: 'x' }).value).toBe('[x]');
  });
  it('renders an optional variable with an invalid value as an error, not as empty', () => {
    expect(reasonOf(() => render('[{note}]', { note: 5 }))).toBe('INVALID_VARIABLE_VALUE');
  });
  it('rejects non-object value bags', () => {
    expect(reasonOf(() => renderTemplate({ source: 'x', contentType: 'PLAIN_TEXT', variables: ALL, values: [] as never, locale: 'en-US' }))).toBe(
      'INVALID_VARIABLE_VALUE',
    );
    expect(reasonOf(() => renderTemplate({ source: 'x', contentType: 'PLAIN_TEXT', variables: ALL, values: 'str' as never, locale: 'en-US' }))).toBe(
      'INVALID_VARIABLE_VALUE',
    );
  });
  it('treats a missing values bag as empty', () => {
    expect(renderTemplate({ source: 'x', contentType: 'PLAIN_TEXT', variables: [], locale: 'en-US' }).value).toBe('x');
  });
  it('rejects an invalid locale and time zone', () => {
    expect(() => render('x', {}, { locale: 'en_US' })).toThrow(ContentError);
    expect(() => render('x', {}, { timeZone: 'Mars/Base' })).toThrow(ContentError);
  });
  it('error details never include the offending value', () => {
    const e = failure(() => render('{name}', { name: 'x'.repeat(300) + 'SECRET' }));
    expect(JSON.stringify([e.message, e.details])).not.toContain('SECRET');
    const u = failure(() => render('x', { SECRETKEY: 1 }));
    expect(u.details.variable).toBe('SECRETKEY');
  });
});

describe('content-type rules', () => {
  it.each(['UI_LABEL', 'EMAIL_SUBJECT', 'PUSH_TITLE'] as const)('%s: rejects a newline in the source and limits to 500 characters', (type) => {
    expect(reasonOf(() => validateTemplate('a\nb', ALL, type))).toBe('CONTENT_TYPE_RULE');
    expect(reasonOf(() => validateTemplate('a\rb', ALL, type))).toBe('CONTENT_TYPE_RULE');
    expect(reasonOf(() => validateTemplate('x'.repeat(501), ALL, type))).toBe('CONTENT_TYPE_RULE');
    expect(() => validateTemplate('x'.repeat(500), ALL, type)).not.toThrow();
  });
  it.each(['UI_LABEL', 'EMAIL_SUBJECT', 'PUSH_TITLE'] as const)('%s: rejects a C1 control or NEL in the source and in a value', (type) => {
    expect(reasonOf(() => validateTemplate('a\u0085b', ALL, type))).toBe('FORBIDDEN_CHARACTER');
    expect(reasonOf(() => validateTemplate('a\u009fb', ALL, type))).toBe('FORBIDDEN_CHARACTER');
    for (const bad of ['\u0085', 'x\u0085y', '\u0080', '\u009f']) {
      const e = failure(() => render('hello {note}', { note: bad }, { contentType: type }));
      expect(e.details).toMatchObject({ reason: 'INVALID_VARIABLE_VALUE', variable: 'note' });
      expect(JSON.stringify([e.message, e.details])).not.toContain('\u0085');
    }
    // A NEL-free label is unaffected, and so are other non-ASCII characters.
    expect(render('héllo {note}', { note: 'wörld' }, { contentType: type }).value).toBe('héllo wörld');
  });
  it('single-line output collapses unicode whitespace and never contains a line terminator', () => {
    // Line terminators cannot enter through source or values any more; this exercises the collapse itself (NBSP, narrow NBSP, tab).
    const out = render('a\u00a0\u202f b\tc', {}, { contentType: 'EMAIL_SUBJECT' }).value;
    expect(out).toBe('a b c');
    expect(out).not.toMatch(/[\r\n\u0085\u2028\u2029]/);
  });
  it.each(['UI_LABEL', 'EMAIL_SUBJECT', 'PUSH_TITLE'] as const)('%s: the 500-character limit applies to the rendered output', (type) => {
    const long = 'y'.repeat(500);
    const e = failure(() => render('x{note}', { note: long }, { contentType: type }));
    expect(e.details).toMatchObject({ reason: 'LIMIT', limit: 500 });
    expect(JSON.stringify([e.message, e.details])).not.toContain('yyyy');
    expect(render('x{note}', { note: 'y'.repeat(499) }, { contentType: type }).value).toHaveLength(500);
    // surrounding whitespace is collapsed and trimmed before the limit is measured
    expect(render(' {note} ', { note: long }, { contentType: type }).value).toHaveLength(500);
    // authoring catches the same thing with the example value
    const vars = [v('note', 'STRING', long)];
    expect(failure(() => validateTemplate('x{note}', vars, type)).details).toMatchObject({ reason: 'LIMIT', phase: 'DRY_RENDER' });
    expect(() => validateTemplate('{note}', vars, type)).not.toThrow();
    // multi-line types are not subject to the single-line limit
    expect(render('x{note}', { note: long }, { contentType: 'PLAIN_TEXT' }).value).toHaveLength(501);
  });
  it('the rendered limit also applies to every plural branch at authoring', () => {
    const vars = [COUNT, v('note', 'STRING', 'y'.repeat(500))];
    const src = '{count, plural, one {x{note}} other {fine}}';
    expect(reasonOf(() => validateTemplate(src, vars, 'UI_LABEL'))).toBe('LIMIT');
  });
  it('single-line types never emit CR/LF, even when a value carries them (header injection)', () => {
    const out = render('Hello {note}', { note: 'a\r\nBcc: evil@example.com\nX: y' }, { contentType: 'EMAIL_SUBJECT' }).value;
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).toBe('Hello a Bcc: evil@example.com X: y');
    expect(render('  a   b  ', {}, { contentType: 'UI_LABEL' }).value).toBe('a b');
    expect(render('x {note}', { note: 'a '.slice(0, 1) }, { contentType: 'PUSH_TITLE' }).value).toBe('x a');
  });
  it('PLAIN_TEXT and PUSH_BODY keep newlines and return text', () => {
    for (const type of ['PLAIN_TEXT', 'PUSH_BODY'] as const) {
      expect(render('a\nb', {}, { contentType: type })).toEqual({ format: 'text', value: 'a\nb' });
    }
  });
  it('plain output is raw text: markup characters are not escaped or interpreted', () => {
    expect(render('<b>**x**</b> & {note}', { note: '<i>' }, { contentType: 'PLAIN_TEXT' })).toEqual({ format: 'text', value: '<b>**x**</b> & <i>' });
  });
  it.each(['RICH_TEXT', 'MARKDOWN', 'EMAIL_BODY', 'LEGAL', 'HELP_ARTICLE'] as const)('%s renders html', (type) => {
    const out = render('Hello **{name}**', { name: 'Ada' }, { contentType: type });
    expect(out.format).toBe('html');
    expect(out.value).toContain('<strong>Ada</strong>');
  });
  it('RICH_TEXT is inline-only: no blocks, newline is <br>', () => {
    expect(render('# not a heading\n- not a list', {}, { contentType: 'RICH_TEXT' }).value).toBe('# not a heading<br>- not a list');
    expect(render('# heading\n\n- item', {}, { contentType: 'MARKDOWN' }).value).toBe('<h2>heading</h2><ul><li>item</li></ul>');
  });
});

describe('validateTemplate', () => {
  it('returns the referenced variables for a valid template', () => {
    expect(validateTemplate('Hi {name}, {count, plural, one {# new} other {# new}}', ALL, 'PLAIN_TEXT')).toEqual({ variables: ['name', 'count'] });
  });
  it('dry-renders with the examples and flags a non-conforming example', () => {
    const bad = [v('name', 'PERSON_DISPLAY_NAME', '')];
    const e = failure(() => validateTemplate('Hi {name}', bad, 'PLAIN_TEXT'));
    expect(e.details).toMatchObject({ reason: 'INVALID_VARIABLE_VALUE', phase: 'DRY_RENDER' });
    const missing = [v('name', 'PERSON_DISPLAY_NAME', undefined)];
    expect(failure(() => validateTemplate('Hi {name}', missing, 'PLAIN_TEXT')).details).toMatchObject({
      reason: 'MISSING_REQUIRED_VARIABLE',
      phase: 'DRY_RENDER',
    });
  });
  it('allows an optional variable without an example', () => {
    expect(() => validateTemplate('[{note}]', [v('note', 'STRING', undefined, false)], 'PLAIN_TEXT')).not.toThrow();
  });
  it('rejects syntax errors', () => {
    expect(reasonOf(() => validateTemplate('{name', ALL, 'PLAIN_TEXT'))).toBe('SYNTAX');
  });
  it('markup types: rejects an unsafe static link at authoring', () => {
    expect(reasonOf(() => validateTemplate('[x](javascript:alert(1))', ALL, 'MARKDOWN'))).toBe('UNSAFE_LINK');
  });
  it('markup types: checks every plural branch, not only the one the example selects', () => {
    const src = '{count, plural, one {[x](https://ok.example)} other {[x](javascript:alert(1))}}';
    // example count is 3 -> 'other'; make the unsafe one the 'one' branch to prove the non-selected branch is checked
    const src2 = '{count, plural, one {[x](javascript:alert(1))} other {fine}}';
    expect(reasonOf(() => validateTemplate(src, ALL, 'MARKDOWN'))).toBe('UNSAFE_LINK');
    expect(reasonOf(() => validateTemplate(src2, ALL, 'MARKDOWN'))).toBe('UNSAFE_LINK');
  });
  describe('dry-render cost', () => {
    const six = '{count, plural, zero {a} one {b} two {c} few {d} many {e} other {f}} ';
    const rendersOf = (fn: () => void): number => {
      const spy = vi.mocked(markup.parseMarkup);
      spy.mockClear();
      fn();
      return spy.mock.calls.length;
    };
    it('renders a body with 198 six-category plural constructs in at most 6 full renders (a count, not a wall-clock bound: timing is flaky on shared CI)', () => {
      const filler = '*a* [x](https://x.com/) text\n- item\n';
      let src = six.repeat(198);
      src += filler.repeat(Math.floor((MAX_TEMPLATE_LENGTH - src.length) / filler.length));
      expect(src.length).toBeLessThanOrEqual(MAX_TEMPLATE_LENGTH);
      for (const type of ['MARKDOWN', 'EMAIL_BODY'] as const) {
        // The work is bounded by the render COUNT: 6 here versus 198 x 6 + 1 for the old per-construct loop. A wall-clock threshold
        // failed on a loaded CI runner (3.6 s against 0.3 s locally), so the deterministic count is the regression guard.
        const renders = rendersOf(() => validateTemplate(src, ALL, type));
        expect(renders).toBe(6);
      }
    });
    it('uses one render without plurals and as many as the richest construct has categories', () => {
      expect(rendersOf(() => validateTemplate('Hi **{name}**', ALL, 'MARKDOWN'))).toBe(1);
      expect(rendersOf(() => validateTemplate('{count, plural, one {a} other {b}} {count, plural, other {c}}', ALL, 'MARKDOWN'))).toBe(2);
      expect(rendersOf(() => validateTemplate(`${six}${six}{count, plural, one {a} other {b}}`, ALL, 'MARKDOWN'))).toBe(6);
    });
    it('still validates every branch of every construct: a bad link or variable in the LAST category of the LAST plural is rejected', () => {
      const many = (last: string): string =>
        `${'{count, plural, one {a} other {b}} '.repeat(150)}{count, plural, zero {z} one {o} two {t} few {f} many {m} other {${last}}}`;
      expect(() => validateTemplate(many('fine'), ALL, 'MARKDOWN')).not.toThrow();
      expect(reasonOf(() => validateTemplate(many('[x](javascript:alert(1))'), ALL, 'MARKDOWN'))).toBe('UNSAFE_LINK');
      expect(reasonOf(() => validateTemplate(many('{nobody}'), ALL, 'MARKDOWN'))).toBe('UNKNOWN_VARIABLE');
      expect(failure(() => validateTemplate(many('[x](javascript:alert(1))'), ALL, 'MARKDOWN')).details).toMatchObject({ phase: 'DRY_RENDER' });
      // every category position of a mixed-size set is reached: the unsafe branch sits in each category in turn
      for (const cat of ['zero', 'one', 'two', 'few', 'many', 'other']) {
        const branches = ['zero', 'one', 'two', 'few', 'many', 'other'].map((c) => `${c} {${c === cat ? '[x](javascript:alert(1))' : 'ok'}}`).join(' ');
        const src = `{count, plural, one {a} other {b}} {count, plural, ${branches}} {count, plural, other {c}}`;
        expect(reasonOf(() => validateTemplate(src, ALL, 'MARKDOWN'))).toBe('UNSAFE_LINK');
      }
    });
  });
  it('markup types: accepts a variable link destination whose example is a safe URL', () => {
    expect(() => validateTemplate('[go]({link})', ALL, 'MARKDOWN')).not.toThrow();
  });
});

describe('no code execution: the language is inert', () => {
  const inert: Array<[string, string, string]> = [
    ['{{7*7}}', '{7*7}', 'double braces are a literal brace pair'],
    ['{{constructor.constructor("return process")()}}', '{constructor.constructor("return process")()}', 'double braces'],
    ['<%= 7*7 %>', '<%= 7*7 %>', 'ERB/EJS tags are text'],
    ['{% if x %}y{% endif %}', '', 'Jinja statements are rejected'],
    ['#{7*7}', '', 'ruby interpolation: braces are a placeholder, not code'],
    ['`${7*7}`', '', 'JS template literal'],
    ['${process.env.SECRET}', '', 'shell/JS interpolation'],
    ['{constructor}', '', 'prototype member as a variable name'],
    ['{toString}', '', 'prototype member as a variable name'],
    ['{__proto__}', '', 'invalid name'],
    ['{hasOwnProperty}', '', 'prototype member as a variable name'],
    ['{name.constructor}', '', 'member access'],
    ['{name()}', '', 'call'],
    ['{name|upper}', '', 'filter'],
    ['{name[0]}', '', 'index'],
  ];
  it.each(inert)('%s is inert or rejected', (source, literal) => {
    let out: string | null = null;
    try {
      out = render(source, { name: 'Ada' }).value;
    } catch (e) {
      expect(e).toBeInstanceOf(ContentError);
      expect((e as ContentError).code).toBe('TEMPLATE_ERROR');
    }
    if (out !== null) {
      expect(out).toBe(literal);
      expect(out).not.toContain('49');
    }
  });
  it('prototype member names never resolve to anything (definitions are a Map)', () => {
    for (const member of ['constructor', 'valueof', 'prototype', 'hasownproperty', 'tostring']) {
      expect(reasonOf(() => render(`{${member}}`, {}))).toBe('UNKNOWN_VARIABLE');
    }
  });
  it('upper-case or underscore-prefixed member names are syntax errors', () => {
    for (const member of ['toString', '__proto__', '_x']) expect(reasonOf(() => render(`{${member}}`, {}))).toBe('SYNTAX');
  });
  it('a provided __proto__ key is an unknown variable, never a prototype write', () => {
    const polluted = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    expect(reasonOf(() => render('x', polluted))).toBe('UNKNOWN_VARIABLE');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('values containing braces, placeholders, plural syntax or markup are never re-interpreted', () => {
    const hostile = [
      '{name}',
      '{{name}}',
      '{count, plural, other {x}}',
      '${process.env.HOME}',
      '<script>alert(1)</script>',
      '**bold**',
      '[x](javascript:alert(1))',
      '{',
      '}',
      '#',
    ];
    for (const value of hostile) {
      expect(render('A: {note} :Z', { note: value }).value).toBe(`A: ${value} :Z`);
      expect(render('{count, plural, other {# [{note}]}}', { count: 2, note: value }).value).toBe(`2 [${value}]`);
    }
  });
  it('values are escaped in markup output and never produce markup', () => {
    const out = render('**{note}**', { note: '<img src=x onerror=alert(1)> **b** [l](javascript:alert(1)) `c`' }, { contentType: 'MARKDOWN' }).value;
    expect(out).toBe('<p><strong>&lt;img src=x onerror=alert(1)&gt; **b** [l](javascript:alert(1)) `c`</strong></p>');
  });
  it('rendering is deterministic and does not mutate shared parse results', () => {
    const a = render('{count, plural, one {# a} other {# b}}', { count: 1 }).value;
    const b = render('{count, plural, one {# a} other {# b}}', { count: 2 }).value;
    expect([a, b, render('{count, plural, one {# a} other {# b}}', { count: 1 }).value]).toEqual(['1 a', '2 b', '1 a']);
  });
});
