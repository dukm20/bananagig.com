import { describe, expect, it } from 'vitest';
import type { ContentType } from '@bananagig/contracts';
import { ContentError } from './errors';
import { findForbiddenCharacter } from './format';
import { assertSafeHtml, checkLinkDestination, escapeHtml, parseMarkup, renderMarkup } from './markup';
import { renderTemplate, type TemplateVariable } from './template';

const REL = 'rel="noopener noreferrer nofollow"';
const ALLOWED_TAG = /<\/?(p|br|strong|em|code|ul|ol|li|blockquote|h2|h3|h4)>|<a href="[^"<>]*"( rel="noopener noreferrer nofollow")?>|<\/a>/g;

/** After removing every allow-listed tag, no angle bracket may remain: nothing from the input can have become markup. */
function expectNoRawMarkup(html: string): void {
  const rest = html.replace(ALLOWED_TAG, '');
  expect(rest).not.toMatch(/[<>]/);
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

describe('rendering the Markdown subset', () => {
  it('renders paragraphs; a single newline is <br>; a blank line separates paragraphs', () => {
    expect(renderMarkup('one\ntwo\n\nthree')).toBe('<p>one<br>two</p><p>three</p>');
    expect(renderMarkup('\n\n  lone  \n\n')).toBe('<p>lone</p>');
    expect(renderMarkup('a\r\nb\rc')).toBe('<p>a<br>b<br>c</p>');
    expect(renderMarkup('')).toBe('');
  });
  it('renders headings # ## ### as h2 h3 h4', () => {
    expect(renderMarkup('# One\n## Two\n### Three')).toBe('<h2>One</h2><h3>Two</h3><h4>Three</h4>');
    expect(renderMarkup('#### Four')).toBe('<p>#### Four</p>');
    expect(renderMarkup('#NoSpace')).toBe('<p>#NoSpace</p>');
    expect(renderMarkup('# ')).toBe('<p>#</p>');
  });
  it('renders unordered and ordered lists', () => {
    expect(renderMarkup('- a\n- b\n* c')).toBe('<ul><li>a</li><li>b</li><li>c</li></ul>');
    expect(renderMarkup('1. a\n2. b\n10. c')).toBe('<ol><li>a</li><li>b</li><li>c</li></ol>');
    expect(renderMarkup('- a\n1. b')).toBe('<ul><li>a</li></ul><ol><li>b</li></ol>');
    expect(renderMarkup('text\n- a')).toBe('<p>text</p><ul><li>a</li></ul>');
  });
  it('renders blockquotes with paragraphs', () => {
    expect(renderMarkup('> quoted\n> more\n>\n> second')).toBe('<blockquote><p>quoted<br>more</p><p>second</p></blockquote>');
  });
  it('renders strong, em (both markers), code and escapes', () => {
    expect(renderMarkup('**b** *i* _j_ `c`')).toBe('<p><strong>b</strong> <em>i</em> <em>j</em> <code>c</code></p>');
    expect(renderMarkup('***both***')).toBe('<p><strong><em>both</em></strong></p>');
    expect(renderMarkup('**bold *and em* text**')).toBe('<p><strong>bold <em>and em</em> text</strong></p>');
    expect(renderMarkup('\\*not em\\* \\[x\\] \\`t\\` \\_u\\_ \\# \\\\')).toBe('<p>*not em* [x] `t` _u_ # \\</p>');
    expect(renderMarkup('a \\q b')).toBe('<p>a \\q b</p>');
  });
  it('does not treat intraword underscores or spaced asterisks as emphasis', () => {
    expect(renderMarkup('snake_case_name and 2 * 3 * 4')).toBe('<p>snake_case_name and 2 * 3 * 4</p>');
    expect(renderMarkup('a*b*c')).toBe('<p>a<em>b</em>c</p>');
  });
  it('code spans are literal', () => {
    expect(renderMarkup('`**not strong** <b>`')).toBe('<p><code>**not strong** &lt;b&gt;</code></p>');
  });
  it('escapes everything that is not the subset', () => {
    expect(renderMarkup('a < b > c & d "q" \'s\'')).toBe('<p>a &lt; b &gt; c &amp; d &quot;q&quot; &#39;s&#39;</p>');
    expect(escapeHtml('<&>"\'')).toBe('&lt;&amp;&gt;&quot;&#39;');
  });
  it('renders http(s) links with rel, other allowed links without', () => {
    expect(renderMarkup('[site](https://example.com/a?b=1&c=2)')).toBe(`<p><a href="https://example.com/a?b=1&amp;c=2" ${REL}>site</a></p>`);
    expect(renderMarkup('[site](HTTP://example.com)')).toBe(`<p><a href="HTTP://example.com" ${REL}>site</a></p>`);
    expect(renderMarkup('[mail](mailto:help@example.com)')).toBe('<p><a href="mailto:help@example.com">mail</a></p>');
    expect(renderMarkup('[call](tel:+15551234567)')).toBe('<p><a href="tel:+15551234567">call</a></p>');
    expect(renderMarkup('[terms](/legal/terms?x=1#top)')).toBe('<p><a href="/legal/terms?x=1#top">terms</a></p>');
    expect(renderMarkup('**[bold link](/x)**')).toBe('<p><strong><a href="/x">bold link</a></strong></p>');
    expect(renderMarkup('[*em* link](/x)')).toBe('<p><a href="/x"><em>em</em> link</a></p>');
  });
  it('escapes a single quote in a destination so it cannot break out of the attribute', () => {
    expect(renderMarkup("[x](/a'onmouseover='alert(1))")).toBe(`<p><a href="/a&#39;onmouseover=&#39;alert(1">x</a>)</p>`);
  });
  it('never emits target, style, class, id, img or event attributes', () => {
    const html = renderMarkup('[a](https://example.com) ![i](https://example.com/i.png) <img src=x> {x}');
    expect(html).not.toMatch(/target=|style=|class=|id=|<img|onerror|on[a-z]+=/i);
  });
  it('leaves a link without a closing parenthesis or with empty text as literal text', () => {
    expect(renderMarkup('[a](/x')).toBe('<p>[a](/x</p>');
    expect(renderMarkup('[](/x)')).toBe('<p>[](/x)</p>');
    expect(renderMarkup('[a] (/x)')).toBe('<p>[a] (/x)</p>');
    expect(renderMarkup('a ] b')).toBe('<p>a ] b</p>');
  });
  it('links do not nest', () => {
    expect(renderMarkup('[a [b](/b) c](/c)')).toBe('<p>[a <a href="/b">b</a> c](/c)</p>');
  });
  it('inline-only mode has no blocks: newline is <br>, block syntax is text', () => {
    expect(renderMarkup('# h\n- a\n> q\n\n1. x', { inlineOnly: true })).toBe('# h<br>- a<br>&gt; q<br><br>1. x');
    expect(renderMarkup('**b** [l](/x)', { inlineOnly: true })).toBe('<strong>b</strong> <a href="/x">l</a>');
  });
  it('checkLinkDestination exposes the allow-list', () => {
    expect(checkLinkDestination('/ok')).toBe('/ok');
    expect(checkLinkDestination('https://example.com')).toBe('https://example.com');
    expect(checkLinkDestination('//evil.com')).toBeNull();
    expect(checkLinkDestination('javascript:alert(1)')).toBeNull();
    expect(checkLinkDestination('mailto:')).toBeNull();
    expect(checkLinkDestination('tel:')).toBeNull();
    expect(checkLinkDestination('')).toBeNull();
  });
});

describe('links that must be rejected at authoring (UNSAFE_LINK)', () => {
  const bad: Array<[string, string]> = [
    ['javascript lower', 'javascript:alert(1)'],
    ['javascript mixed case', 'JaVaScRiPt:alert(1)'],
    ['javascript upper', 'JAVASCRIPT:alert(1)'],
    ['javascript with tab', 'java\tscript:alert(1)'],
    ['javascript with newline', 'java\nscript:alert(1)'],
    ['javascript with carriage return', 'java\rscript:alert(1)'],
    ['javascript with space', 'java script:alert(1)'],
    ['javascript with leading NUL', '\u0000javascript:alert(1)'],
    ['javascript with leading space', ' javascript:alert(1)'],
    ['javascript with zero-width space', 'java\u200bscript:alert(1)'],
    ['javascript with leading C1 control', '\u0085javascript:alert(1)'],
    ['javascript with named entity colon', 'javascript&colon;alert(1)'],
    ['javascript with numeric entity colon', 'javascript&#58;alert(1)'],
    ['javascript with hex entity colon', 'javascript&#x3A;alert(1)'],
    ['javascript with decimal entity letter', '&#106;avascript:alert(1)'],
    ['javascript with hex entity letter', '&#x6A;avascript:alert(1)'],
    ['javascript with percent-encoded letter', '%6Aavascript:alert(1)'],
    ['javascript with percent-encoded colon', 'javascript%3Aalert(1)'],
    ['javascript with percent-encoded tab', 'jav%09ascript:alert(1)'],
    ['javascript with full-width letter', '\uff4aavascript:alert(1)'],
    ['javascript with comment-slash', 'javascript://%0aalert(1)'],
    ['data html', 'data:text/html,<script>alert(1)</script>'],
    ['data upper', 'DATA:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
    ['data image', 'data:image/svg+xml,<svg onload=alert(1)>'],
    ['vbscript', 'vbscript:msgbox(1)'],
    ['vbscript mixed', 'VbScRiPt:msgbox(1)'],
    ['file', 'file:///etc/passwd'],
    ['ftp', 'ftp://example.com/x'],
    ['blob', 'blob:https://example.com/uuid'],
    ['about', 'about:blank'],
    ['intent', 'intent://scan/#Intent;scheme=zxing;end'],
    ['sms', 'sms:+15551234567'],
    ['protocol-relative', '//evil.example'],
    ['triple slash', '///evil.example'],
    ['backslash host', '\\\\evil.example'],
    ['slash backslash', '/\\evil.example'],
    ['backslash slash', '\\/evil.example'],
    ['https with backslashes', 'https:\\\\evil.example'],
    ['fragment only', '#frag'],
    ['query only', '?q=1'],
    ['relative path', 'relative/path'],
    ['dot relative', './x'],
    ['parent relative', '../x'],
    ['scheme-less host', 'www.example.com'],
    ['http without slashes', 'http:evil.example'],
    ['https with credentials', 'https://user:pw@evil.example'],
    ['mailto empty', 'mailto:'],
    ['tel empty', 'tel:'],
    ['quote breakout', 'https://x.example" onmouseover="alert(1)'],
    ['quote breakout without space', 'https://x.example"onmouseover="alert(1)'],
    ['angle brackets', 'https://x.example/<script>'],
    ['wrapped in angle brackets', '<javascript:alert(1)>'],
    ['backtick', 'https://x.example/`x'],
    ['non-ascii', 'https://x.example/caf\u00e9'],
    ['title syntax', 'https://x.example "title"'],
    ['empty-looking', ' '],
  ];
  it.each(bad)('%s', (_label, dest) => {
    const e = failure(() => renderMarkup(`before [click me](${dest}) after`));
    expect(e.code).toBe('TEMPLATE_ERROR');
    expect(e.details.reason).toBe('UNSAFE_LINK');
    expect(JSON.stringify(e.details)).not.toContain('click me');
    // also in the middle of emphasis, lists, quotes, headings and inline-only mode
    // (a destination broken across lines is not a link in line-based blocks: it stays escaped text, covered by the hostile corpus)
    const wraps = /[\r\n]/.test(dest) ? ['**[x](D)**'] : ['**[x](D)**', '- [x](D)', '> [x](D)', '# [x](D)'];
    for (const wrap of wraps) {
      expect(failure(() => renderMarkup(wrap.replace('D', dest))).details.reason).toBe('UNSAFE_LINK');
    }
    expect(failure(() => renderMarkup(`[x](${dest})`, { inlineOnly: true })).details.reason).toBe('UNSAFE_LINK');
  });
  it('has at least 50 distinct bad destinations', () => {
    expect(new Set(bad.map((b) => b[1])).size).toBeGreaterThanOrEqual(50);
  });
  it('an image-syntax link with a bad destination is rejected too', () => {
    expect(failure(() => renderMarkup('![x](javascript:alert(1))')).details.reason).toBe('UNSAFE_LINK');
  });
});

describe('hostile corpus: every output is allow-list-verified and carries no raw markup from the input', () => {
  const vectors: Array<[string, string]> = [
    ['script tag', '<script>alert(1)</script>'],
    ['script with src', '<script src="https://evil.example/x.js"></script>'],
    ['img onerror', '<img src=x onerror=alert(1)>'],
    ['img onerror quoted', '<img src="x" onerror="alert(1)">'],
    ['img slashes', '<img/src=x/onerror=alert(1)>'],
    ['img mixed case', '<ImG sRc=x OnErRoR=alert(1)>'],
    ['svg onload', '<svg onload=alert(1)>'],
    ['svg script', '<svg><script>alert(1)</script></svg>'],
    ['svg animate', '<svg><animate onbegin=alert(1) attributeName=x dur=1s>'],
    ['iframe javascript', '<iframe src="javascript:alert(1)"></iframe>'],
    ['iframe srcdoc', '<iframe srcdoc="<script>alert(1)</script>">'],
    ['anchor javascript', '<a href="javascript:alert(1)">x</a>'],
    ['anchor unquoted', '<a href=javascript:alert(1)>x</a>'],
    ['body onload', '<body onload=alert(1)>'],
    ['math href', '<math><mi xlink:href="data:x,<script>alert(1)</script>">'],
    ['style import', "<style>@import 'https://evil.example/x.css'</style>"],
    ['style attribute', '<p style="background:url(javascript:alert(1))">x</p>'],
    ['html comment', '<!-- <script>alert(1)</script> -->'],
    ['cdata', '<![CDATA[<script>alert(1)</script>]]>'],
    ['split script tag', '<scr<script>ipt>alert(1)</scr</script>ipt>'],
    ['double angle', '<<script>script>alert(1)<</script>/script>'],
    ['attribute breakout double', '"><script>alert(1)</script>'],
    ['attribute breakout single', "'><img src=x onerror=alert(1)>"],
    ['unclosed tag', '<img src="x" onerror="alert(1)"'],
    ['object embed', '<object data="javascript:alert(1)"><embed src="javascript:alert(1)">'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">'],
    ['base tag', '<base href="https://evil.example/">'],
    ['form action', '<form action="javascript:alert(1)"><button>x</button></form>'],
    ['entity-encoded script', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['numeric-entity script', '&#60;script&#62;alert(1)&#60;/script&#62;'],
    ['hex-entity script', '&#x3c;script&#x3e;alert(1)&#x3c;/script&#x3e;'],
    ['backslash-escaped script', '\\<script>alert(1)\\</script>'],
    ['double backslash script', '\\\\<script>alert(1)</script>'],
    ['markdown image with onerror in alt', '![<img src=x onerror=alert(1)>](https://example.com/a.png)'],
    ['markdown image', '![alt](https://example.com/a.png "title")'],
    ['html in link text', '[<script>alert(1)</script>](https://example.com)'],
    ['html img in link text', '[<img src=x onerror=alert(1)>](/ok)'],
    ['html anchor around markdown link', '<a href="x">[y](https://example.com)</a>'],
    ['escaped bracket link', '\\[a](javascript:alert(1))'],
    ['escaped closing bracket link', '[a\\](javascript:alert(1))'],
    ['code span with script', '`<script>alert(1)</script>`'],
    ['code span with link', '`[x](javascript:alert(1))`'],
    ['emphasis around script', '**<script>alert(1)</script>**'],
    ['emphasis breaking tag', '<scr*ipt>alert(1)</scr*ipt>'],
    ['underscore breaking tag', '<scr_ipt>alert(1)</scr_ipt>'],
    ['heading with script', '# <script>alert(1)</script>'],
    ['list with script', '- <script>alert(1)</script>\n- <img src=x onerror=alert(1)>'],
    ['quote with script', '> <script>alert(1)</script>'],
    ['ordered list with script', '1. <svg onload=alert(1)>'],
    ['null bytes around tag', '<scr\u0000ipt>alert(1)</script>'],
    ['sentinel-looking text', 'text \ue000 0 \ue001 more'],
    ['unmatched emphasis', '**bold *em** text*'],
    ['only markers', '***'],
    ['markers soup', '*_*_*_**__**__'],
    ['lone brackets', '[ ] [[ ]] ]( )('],
    ['empty link forms', '[]() [](x) [a]() '],
    ['nested unclosed', '*a **b ***c ****d'],
    ['unclosed link', '[a](https://example.com'],
    ['unclosed link then close', '[a](https://example.com [b](https://example.com)'],
    ['nested link brackets', '[[[a](/x)](/y)](/z)'],
    ['adjacent links', '[a](/x)[b](/y)[c](/z)'],
    ['link text with markers', '[**a*](/x)*'],
    ['emphasis straddling a link', '*a [b* c](/x)'],
    ['link straddling emphasis', '[a *b](/x) c*'],
    ['html entity in link destination', '[a](/x?a=1&amp;b=2&lt;script&gt;)'],
    ['quote and ampersand in text', 'a "b" & \'c\' <d>'],
    ['rtl override text', 'abc \u202e cba'],
    ['very long word', 'a'.repeat(100000)],
    ['crlf soup', '\r\n\r\n\r<script>\r\n'],
    ['table-like', '| a | b |\n|---|---|\n| <script> | x |'],
    ['horizontal rule and setext', '---\n===\ntext\n---'],
    ['four-space indent code', '    <script>alert(1)</script>'],
    ['tab indent code', '\t<script>alert(1)</script>'],
  ];

  it('has at least 60 vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(60);
  });

  it.each(vectors)('block mode: %s', (_label, source) => {
    let html: string | null = null;
    try {
      html = renderMarkup(source);
    } catch (e) {
      expect(e).toBeInstanceOf(ContentError);
      expect((e as ContentError).code).toBe('TEMPLATE_ERROR');
    }
    if (html !== null) {
      assertSafeHtml(html);
      expectNoRawMarkup(html);
      expect(html).not.toMatch(/[\ue000\ue001]/);
    }
  });
  it.each(vectors)('inline-only mode: %s', (_label, source) => {
    let html: string | null = null;
    try {
      html = renderMarkup(source, { inlineOnly: true });
    } catch (e) {
      expect(e).toBeInstanceOf(ContentError);
    }
    if (html !== null) {
      assertSafeHtml(html);
      expectNoRawMarkup(html);
    }
  });
  it('shows raw HTML as visible escaped text, never as elements', () => {
    expect(renderMarkup('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(renderMarkup('<img src=x onerror=alert(1)>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    expect(renderMarkup('&lt;b&gt;')).toBe('<p>&amp;lt;b&amp;gt;</p>');
  });
  it('the same vectors are safe when produced by a template (a variable value, a literal and inside a plural branch)', () => {
    const vars: TemplateVariable[] = [
      { name: 'v', type: 'STRING', example: 'x', required: true },
      { name: 'n', type: 'COUNT', example: 2, required: true },
    ];
    for (const [, source] of vectors) {
      if (findForbiddenCharacter(source) !== -1 || source.length > 400) continue;
      const asValue = renderTemplate({
        source: '**{v}** {n, plural, one {# one} other {# other}}',
        contentType: 'MARKDOWN',
        variables: vars,
        values: { v: source, n: 2 },
        locale: 'en-US',
      }).value;
      assertSafeHtml(asValue);
      expectNoRawMarkup(asValue);
      expect(asValue).toContain('<strong>');
      expect(asValue).not.toMatch(/<a /);
    }
  });
});

describe('variables never introduce markup (inserted after parsing)', () => {
  const vars: TemplateVariable[] = [
    { name: 'name', type: 'STRING', example: 'x', required: true },
    { name: 'url', type: 'URL', example: 'https://example.com/a', required: true },
    { name: 'raw', type: 'STRING', example: '/ok', required: true },
    { name: 'host', type: 'STRING', example: 'example.com', required: true },
  ];
  const md = (source: string, values: Record<string, unknown>, contentType: ContentType = 'MARKDOWN'): string =>
    renderTemplate({ source, contentType, variables: vars, values, locale: 'en-US' }).value;
  const attempt = (source: string, values: Record<string, unknown>): string | ContentError => {
    try {
      return md(source, values);
    } catch (e) {
      expect(e).toBeInstanceOf(ContentError);
      return e as ContentError;
    }
  };

  it('escapes markup, quotes and entities in values', () => {
    expect(md('Hi {name}!', { name: '<b>"x"</b> & \'y\'' })).toBe('<p>Hi &lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; &#39;y&#39;!</p>');
  });
  it('does not parse markdown syntax inside values, even inside emphasis, links, headings and lists', () => {
    const value = '**b** *i* `c` [l](https://example.com) # h\n- li\n> q';
    expect(md('# {name}', { name: value })).toBe('<h2>**b** *i* `c` [l](https://example.com) # h\n- li\n&gt; q</h2>');
    expect(md('- {name}', { name: value })).toContain('<ul><li>**b**');
    expect(md('[{name}](/x)', { name: value })).toContain('<a href="/x">**b**');
    expect(md('*{name}*', { name: '*' })).toBe('<p><em>*</em></p>');
    expect(md('**{name}**', { name: '**' })).toBe('<p><strong>**</strong></p>');
  });
  it('a value cannot close or open emphasis or a link around itself', () => {
    expect(md('*a {name} b*', { name: '*' })).toBe('<p><em>a * b</em></p>');
    expect(md('[a {name}](/x)', { name: '](javascript:alert(1))' })).toBe('<p><a href="/x">a ](javascript:alert(1))</a></p>');
  });
  it('inline-only types insert values as escaped text', () => {
    expect(md('{name}', { name: '<script>' }, 'RICH_TEXT')).toBe('&lt;script&gt;');
    expect(md('{name}', { name: 'a\nb' }, 'RICH_TEXT')).toBe('a\nb');
  });
  it('a value that looks like a placeholder index token is just text', () => {
    expect(md('{name} {raw}', { name: '0', raw: '1' })).toBe('<p>0 1</p>');
    expect(md('{name}', { name: '\\*x\\*' })).toBe('<p>\\*x\\*</p>');
  });
  it('rejects values or sources that carry the reserved sentinels', () => {
    for (const sentinel of ['\ue000', '\ue001', '\ue0000\ue001']) {
      const e = attempt('{name}', { name: `a${sentinel}b` });
      expect(e).toBeInstanceOf(ContentError);
      expect((e as ContentError).details.reason).toBe('INVALID_VARIABLE_VALUE');
      const t = failure(() => md(`a${sentinel}b`, {}));
      expect(t.details.reason).toBe('FORBIDDEN_CHARACTER');
    }
  });
  it('the markup parser itself refuses unexpected or out-of-range sentinel tokens', () => {
    expect(failure(() => parseMarkup('a \ue0000\ue001 b')).details.reason).toBe('FORBIDDEN_CHARACTER');
    expect(failure(() => parseMarkup('a \ue0005\ue001 b', { placeholderCount: 2 })).details.reason).toBe('FORBIDDEN_CHARACTER');
    expect(failure(() => parseMarkup('a \ue001 b')).details.reason).toBe('FORBIDDEN_CHARACTER');
    expect(failure(() => parseMarkup('a \ue000x\ue001 b', { placeholderCount: 2 })).details.reason).toBe('FORBIDDEN_CHARACTER');
    expect(failure(() => parseMarkup('a \ue000 5 b', { placeholderCount: 9 })).details.reason).toBe('FORBIDDEN_CHARACTER');
    expect(failure(() => parseMarkup('[a](\ue0000\ue001\ue001)', { placeholderCount: 1 })).details.reason).toBe('FORBIDDEN_CHARACTER');
    expect(failure(() => parseMarkup('`a\ue001b`', { placeholderCount: 1 })).details.reason).toBe('FORBIDDEN_CHARACTER');
    expect(parseMarkup('a \ue0001\ue001 b', { placeholderCount: 2 }).kind).toBe('blocks');
  });

  describe('variables as link destinations', () => {
    it('accepts a normalized URL value', () => {
      expect(md('[go]({url})', { url: 'https://Example.com/a b'.replace(' ', '%20') })).toBe(`<p><a href="https://example.com/a%20b" ${REL}>go</a></p>`);
    });
    it('percent-encodes quote/space/angle characters carried by a URL value (no attribute breakout)', () => {
      const out = md('[go]({url})', { url: 'https://example.com/a"onclick="alert(1)<script>' });
      expect(out).toBe(`<p><a href="https://example.com/a%22onclick=%22alert(1)%3Cscript%3E" ${REL}>go</a></p>`);
      expect(out).not.toMatch(/" onclick|"onclick/);
    });
    it('rejects an unsafe destination produced by a variable with INVALID_VARIABLE_VALUE', () => {
      for (const raw of [
        'javascript:alert(1)',
        'JaVaScRiPt:alert(1)',
        'data:text/html,x',
        '//evil.example',
        'vbscript:x',
        'java\tscript:x',
        ' javascript:x',
        'x" onclick="y',
        '\\\\evil',
        '#frag',
        'relative',
      ]) {
        const e = failure(() => md('[go]({raw})', { raw }));
        expect(e.code).toBe('TEMPLATE_ERROR');
        expect(e.details.reason).toBe('INVALID_VARIABLE_VALUE');
        expect(e.details.variables).toEqual(['raw']);
        expect(JSON.stringify([e.message, e.details])).not.toContain(raw.trim() || 'zzz');
      }
    });
    it('accepts safe variable destinations (root-relative, mailto)', () => {
      expect(md('[go]({raw})', { raw: '/help/start?x=1' })).toBe('<p><a href="/help/start?x=1">go</a></p>');
      expect(md('[mail](mailto:{raw})', { raw: 'help@example.com' })).toBe('<p><a href="mailto:help@example.com">mail</a></p>');
    });
    it('validates the composed destination, so a prefix cannot be turned into a protocol-relative link', () => {
      expect(failure(() => md('[go](/{raw})', { raw: '/evil.example' })).details.reason).toBe('INVALID_VARIABLE_VALUE');
      expect(failure(() => md('[go](/{raw})', { raw: '\\evil.example' })).details.reason).toBe('INVALID_VARIABLE_VALUE');
      expect(md('[go](/{raw})', { raw: 'ok' })).toBe('<p><a href="/ok">go</a></p>');
    });
    it('a host prefix keeps the link on an allowed scheme and rel handling follows the composed destination', () => {
      expect(md('[go](https://{host}/x)', { host: 'example.com' })).toBe(`<p><a href="https://example.com/x" ${REL}>go</a></p>`);
      expect(failure(() => md('[go](https://{host}/x)', { host: 'exa mple.com' })).details.reason).toBe('INVALID_VARIABLE_VALUE');
      expect(failure(() => md('[go](https://{host}/x)', { host: 'user:pw@evil.example' })).details.reason).toBe('INVALID_VARIABLE_VALUE');
    });
    it('rejects at authoring a destination whose static prefix cannot form an allowed destination', () => {
      for (const src of ['[go](javascript:{raw})', '[go](data:{raw})', '[go](//{raw})', '[go](relative/{raw})', '[go](ftp://{raw})']) {
        expect(failure(() => md(src, { raw: 'x' })).details.reason).toBe('UNSAFE_LINK');
      }
    });
    it('a variable value as the whole destination with an empty value is rejected', () => {
      expect(failure(() => md('[go]({raw})', { raw: '' })).details.reason).toBe('INVALID_VARIABLE_VALUE');
    });
    it('a value containing a closing parenthesis cannot end the destination early', () => {
      expect(failure(() => md('[go]({raw})', { raw: 'x) [y](javascript:alert(1)' })).details.reason).toBe('INVALID_VARIABLE_VALUE');
    });
  });
});

describe('pathological inputs finish fast (no ReDoS / quadratic behavior)', () => {
  const cases: Array<[string, string]> = [
    ['200k asterisks', '*'.repeat(200000)],
    ['200k underscores', '_'.repeat(200000)],
    ['openers only: "*a " x 60k', '*a '.repeat(60000)],
    ['openers only: "_a " x 60k', '_a '.repeat(60000)],
    ['alternating closers: "a* " x 60k', 'a* '.repeat(60000)],
    ['mixed markers: "*a _b " x 40k', '*a _b '.repeat(40000)],
    ['strong/em soup: "**a*" x 40k', '**a*'.repeat(40000)],
    ['nested emphasis then closers', '*'.repeat(50000) + 'a' + '*'.repeat(50000)],
    ['openers then unmatched closers', '*a '.repeat(30000) + 'b* '.repeat(30000)],
    ['deep em: "*a" x 100k then "a*" x 100k', '*a'.repeat(50000) + 'a*'.repeat(50000)],
    ['100k open brackets', '['.repeat(100000)],
    ['100k close brackets', ']'.repeat(100000)],
    ['brackets then parens', '['.repeat(50000) + ']('.repeat(50000)],
    ['"[a](" x 40k (never closed)', '[a]('.repeat(40000)],
    ['"[a](/x" x 30k then one ")"', '[a](/x'.repeat(30000) + ')'],
    ['"[a](/x)" x 30k (valid links)', '[a](/x)'.repeat(30000)],
    ['"[a](/x)(" x 30k', '[a](/x)('.repeat(30000)],
    ['"](" x 100k with a bracket first', '[' + ']('.repeat(100000)],
    ['100k backticks', '`'.repeat(100000)],
    ['"`a" x 60k (odd backticks)', '`a'.repeat(60001)],
    ['"`a`" x 60k', '`a`'.repeat(60000)],
    ['100k backslashes', '\\'.repeat(100000)],
    ['"\\*" x 100k', '\\*'.repeat(100000)],
    ['"> " x 100k', '> '.repeat(100000)],
    ['">\\n" x 60k', '>\n'.repeat(60000)],
    ['"- a\\n" x 60k', '- a\n'.repeat(60000)],
    ['"1. a\\n" x 40k', '1. a\n'.repeat(40000)],
    ['"# a\\n" x 60k', '# a\n'.repeat(60000)],
    ['100k newlines', '\n'.repeat(100000)],
    ['one 200k line of words', 'word '.repeat(40000)],
    ['entities soup', '&amp;&lt;&#60;&#x3c;'.repeat(20000)],
    ['angle brackets soup', '<a><b></c>'.repeat(20000)],
    ['spaces then text', ' '.repeat(200000) + 'x'],
    ['emphasis with long spaces inside', '*' + ' '.repeat(100000) + '*'],
    ['alternating * and [', '*['.repeat(60000)],
    ['link text with many emphasis', '[' + '*a '.repeat(40000) + '](/x)'],
    ['whole-document unicode', '\u00e9*'.repeat(60000)],
    ['regex-killer style "a" x 100k + "!"', 'a'.repeat(100000) + '!'],
    ['regex-killer style "(a+)+$"', '('.repeat(50000) + 'a'.repeat(50000) + '!'],
  ];

  it.each(cases)('%s', (_label, source) => {
    for (const inlineOnly of [false, true]) {
      const started = performance.now();
      let html: string | null = null;
      try {
        html = renderMarkup(source, { inlineOnly });
      } catch (e) {
        expect(e).toBeInstanceOf(ContentError);
      }
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(2000);
      if (html !== null) {
        assertSafeHtml(html);
        expectNoRawMarkup(html);
      }
    }
  });

  it('keeps nesting bounded: very deep emphasis cannot overflow the stack', () => {
    const html = renderMarkup('*a '.repeat(5000) + 'b' + '* '.repeat(5000));
    assertSafeHtml(html);
    expect((html.match(/<em>/g) ?? []).length).toBeLessThanOrEqual(40);
  });
  it('bounds link-attempt scanning: a 100k "](" run after one bracket is fast and stays text', () => {
    const html = renderMarkup('[a' + ']('.repeat(100000));
    expect(html.startsWith('<p>[a](')).toBe(true);
  });
});

describe('assertSafeHtml', () => {
  it('accepts every construct the renderer produces', () => {
    const html = renderMarkup('# T\n\n**b** *i* `c` [x](https://example.com) [m](mailto:a@b.co) [p](/p)\n\n- a\n- b\n\n1. c\n\n> q');
    expect(() => assertSafeHtml(html)).not.toThrow();
    expect(() => assertSafeHtml('<p>a &amp; b &lt; &gt; &quot; &#39;</p>')).not.toThrow();
    expect(() => assertSafeHtml('')).not.toThrow();
    expect(() => assertSafeHtml('plain text')).not.toThrow();
    expect(() => assertSafeHtml(`<a href="https://x.example/?a=1&amp;b=2" ${REL}>x</a>`)).not.toThrow();
    expect(() => assertSafeHtml('<p>tab\tand\nnewline</p>')).not.toThrow();
  });
  const bad: Array<[string, string]> = [
    ['script', '<script>alert(1)</script>'],
    ['img', '<img src=x>'],
    ['svg', '<svg onload=alert(1)>'],
    ['iframe', '<iframe></iframe>'],
    ['style tag', '<style>x</style>'],
    ['div', '<div>x</div>'],
    ['span', '<span>x</span>'],
    ['upper-case tag', '<P>x</P>'],
    ['comment', '<!-- x -->'],
    ['doctype', '<!DOCTYPE html>'],
    ['javascript href', '<a href="javascript:alert(1)">x</a>'],
    ['data href', '<a href="data:text/html,x">x</a>'],
    ['protocol-relative href', '<a href="//evil.example">x</a>'],
    ['href without rel on http', '<a href="https://x.example">x</a>'],
    ['wrong rel on http', '<a href="https://x.example" rel="noopener">x</a>'],
    ['rel on a relative link', `<a href="/x" ${REL}>x</a>`],
    ['target attribute', '<a href="/x" target="_blank">x</a>'],
    ['onclick on a', '<a href="/x" onclick="alert(1)">x</a>'],
    ['style on a', '<a href="/x" style="x">x</a>'],
    ['onclick on p', '<p onclick="alert(1)">x</p>'],
    ['class on p', '<p class="x">x</p>'],
    ['id on strong', '<strong id="x">x</strong>'],
    ['a without href', '<a>x</a>'],
    ['single-quoted attribute', "<a href='/x'>x</a>"],
    ['unquoted attribute', '<a href=/x>x</a>'],
    ['upper-case attribute', '<a HREF="/x">x</a>'],
    ['duplicate href', '<a href="/x" href="/y">x</a>'],
    ['attribute without space', '<a href="/x"onclick="y">x</a>'],
    ['trailing space in tag', '<a href="/x" >x</a>'],
    ['unterminated attribute', '<a href="/x>x</a>'],
    ['angle bracket inside attribute', '<a href="/x<y">x</a>'],
    ['unescaped ampersand in attribute', '<a href="/x?a=1&b=2">x</a>'],
    ['unknown entity in attribute', '<a href="/x?a=&copy;">x</a>'],
    ['self-closing br', '<br/>'],
    ['br with space', '<br >'],
    ['closing br', '<br></br>'],
    ['attribute on br', '<br class="x">'],
    ['unclosed p', '<p>x'],
    ['stray closing tag', '</p>'],
    ['mismatched closing tag', '<p><strong>x</p></strong>'],
    ['li closing out of order', '<ul><li></ul></li>'],
    ['raw greater-than in text', 'a > b'],
    ['raw less-than in text', 'a < b'],
    ['raw less-than before space', '<p>1 < 2</p>'],
    ['bare ampersand', '<p>a & b</p>'],
    ['unknown entity', '<p>&copy;</p>'],
    ['numeric entity', '<p>&#60;script&#62;</p>'],
    ['unterminated entity', '<p>&amp</p>'],
    ['NUL', '<p>a\u0000b</p>'],
    ['control character', '<p>a\u001bb</p>'],
    ['DEL', '<p>a\u007fb</p>'],
    ['sentinel open', '<p>a\ue000b</p>'],
    ['sentinel close', '<p>a\ue001b</p>'],
    ['unterminated tag', '<p'],
    ['empty tag name', '<>'],
    ['tag with digits and junk', '<h2x>y</h2x>'],
    ['too deeply nested', '<blockquote>'.repeat(101) + '</blockquote>'.repeat(101)],
  ];
  it.each(bad)('rejects %s', (_label, html) => {
    const e = failure(() => assertSafeHtml(html));
    expect(e.code).toBe('TEMPLATE_ERROR');
    expect(e.details.reason).toBe('UNSAFE_HTML');
  });
  it('accepts nesting at the depth limit', () => {
    expect(() => assertSafeHtml('<blockquote>'.repeat(100) + '</blockquote>'.repeat(100))).not.toThrow();
  });
});
