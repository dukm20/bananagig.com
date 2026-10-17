// ACC-001 web side, part 4: source-level guarantees of the account area that a rendered page cannot show: no hardcoded visible copy in the JSX, no script, labelled form controls,
// the structure of the routes, the workspace boundaries, and the accessibility / responsive rules of the CSS (44x44 targets, visible focus, nothing hover-only, mobile first).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_SECTIONS, SECTION_ROUTE_PATTERN } from '@bananagig/contracts';
import { ROUTE_OF } from './testing/account-area-stub';

const SRC = import.meta.dirname;
const read = (rel: string): string => readFileSync(path.join(SRC, rel), 'utf8');
const walk = (dir: string, out: string[] = []): string[] => {
  for (const n of readdirSync(dir)) {
    const full = path.join(dir, n);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};
const rel = (f: string): string => path.relative(SRC, f);
/** The account area's own source: the pages, layout and components, and the server helper they share. */
const AREA_FILES = [...walk(path.join(SRC, 'app/account')), path.join(SRC, 'lib/account-area.ts')].filter((f) => /\.(ts|tsx)$/.test(f));
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '');

/** The text a person would read straight after a JSX tag (up to the next tag or expression). Whitespace-only and expression children are fine; any words are suspicious. */
const TAG = /(?:<>|<\/>|<\/?[A-Za-z][\w.]*(?:\s+[\w:-]+(?:=(?:"[^"]*"|'[^']*'|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}))?)*\s*\/?>)/g;
export function suspiciousJsxText(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  for (const m of code.matchAll(TAG)) {
    if (/^<[A-Z]>$/.test(m[0])) continue; // a type parameter (`publicList<T>(...)`), not an element
    const after = code.slice(m.index + m[0].length);
    const text = /^[^<>{}]*/.exec(after)![0].trim();
    // what follows a tag in a ternary or a logical expression (`</p> : null`, `</a>) : null`) is code, not a sentence
    if (/[A-Za-z]{2,}/.test(text) && !/^[:;?),&|]/.test(text)) found.push(text);
  }
  // string-literal children: {'Save'} / {"Save"} / {`Save`}
  for (const m of code.matchAll(/\{\s*(['"`])([^'"`]*[A-Za-z]{2,}[^'"`]*)\1\s*\}/g)) found.push(m[2]!);
  return found;
}
/** Text attributes a person reads or hears, written as a literal. */
const LITERAL_TEXT_ATTRIBUTE = /\s(?:aria-label|aria-description|aria-placeholder|title|alt|placeholder)=(?:"[^"]*[A-Za-z]{2,}[^"]*"|'[^']*[A-Za-z]{2,}[^']*')/;

describe('the account area source', () => {
  it('scans the files it should', () => {
    const names = AREA_FILES.map(rel).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        'app/account/layout.tsx',
        'app/account/page.tsx',
        'app/account/profile/page.tsx',
        'app/account/contact/page.tsx',
        'app/account/security/page.tsx',
        'app/account/language-region/page.tsx',
        'app/account/privacy/page.tsx',
        'app/account/roles/page.tsx',
        'app/account/[section]/page.tsx',
        'app/account/_components/nav-links.tsx',
        'app/account/_components/section-frame.tsx',
        'app/account/_components/feedback.tsx',
        'lib/account-area.ts',
      ]),
    );
  });

  describe('no hardcoded visible copy', () => {
    it('the scanner finds words between tags and in string children, and ignores expressions, whitespace and comments', () => {
      for (const bad of [
        '<p>Hello world</p>',
        '<h1>Profile</h1>',
        '<a href="/x" className="y">Back</a>',
        '<button type="submit">Save</button>',
        '<label htmlFor="a">First name</label>',
        '<p>{x}</p><span>Current role</span>',
        '<>Text</>',
        "<p>{'Saved'}</p>",
        '<div data-x={fn({ a: { b: 1 } })}>Words here</div>',
      ])
        expect(suspiciousJsxText(bad), bad).not.toEqual([]);
      for (const ok of [
        '<p>{copy.node(C.title)}</p>',
        '<p> {a} </p>',
        '<span>{" "}</span>',
        '<p>\n  {a}\n</p>',
        '{/* Save the changes */}<p>{a}</p>',
        '// <p>Hello</p>\n<p>{a}</p>',
        '<li key={r.code}><span>{r.name}</span></li>',
        '{a ? <p>{b}</p> : null}',
        '{a ? (<p>{b}</p>) : null}',
        '<dd>{data.activeSessionCount}</dd>',
        '<input type="hidden" name="role" value="PROVIDER"/>',
        'const x: Array<string> = [];',
        'async function f<T>(read: () => Promise<T[]>) {}',
      ])
        expect(suspiciousJsxText(ok), ok).toEqual([]);
    });
    it('no JSX text and no text attribute of the account pages, layout and components is a literal', () => {
      for (const f of AREA_FILES.filter((x) => x.endsWith('.tsx'))) {
        const src = read(rel(f));
        expect(suspiciousJsxText(src), rel(f)).toEqual([]);
        expect(stripComments(src), rel(f)).not.toMatch(LITERAL_TEXT_ATTRIBUTE);
      }
    });
    it('no phrase literal (two or more words in a string) in the account area code: copy is a content key, never a sentence', () => {
      for (const f of AREA_FILES) {
        const phrases = [
          ...stripComments(read(rel(f)))
            .replace(/^['"]use client['"];?/m, '')
            .matchAll(/(['"`])([A-Za-z][A-Za-z']*(?: [A-Za-z][A-Za-z']*)+)\1/g),
        ].map((m) => m[2]);
        expect(phrases, rel(f)).toEqual([]);
      }
    });
    it("the pages take every word from the registry helpers: no `?? 'literal'` fallback for copy", () => {
      for (const f of AREA_FILES) expect(stripComments(read(rel(f))), rel(f)).not.toMatch(/\?\?\s*['"`][A-Za-z]/);
    });
  });

  describe('no script', () => {
    it('only the section list is a client component (to mark the current page, rendered on the server too); no handler, effect, state or browser storage anywhere', () => {
      const clients = AREA_FILES.filter((f) => /^['"]use client['"]/m.test(read(rel(f)))).map(rel);
      expect(clients).toEqual(['app/account/_components/nav-links.tsx']);
      for (const f of AREA_FILES) {
        const code = stripComments(read(rel(f)));
        expect(code, rel(f)).not.toMatch(
          /\bon[A-Z][A-Za-z]*=\{|useEffect|useState|useReducer|useLayoutEffect|localStorage|sessionStorage|document\.|window\.|<script|dangerouslySetInnerHTML|<noscript/,
        );
      }
    });
    it('forms are plain POST forms to the BFF routes, and nothing in the area builds a GET that changes state', () => {
      const actions = new Set<string>();
      for (const f of AREA_FILES.filter((x) => x.endsWith('.tsx'))) {
        const code = stripComments(read(rel(f)));
        for (const m of code.matchAll(/<form\b([^>]*)>/g)) {
          expect(m[1], rel(f)).toMatch(/method="post"/);
          const action = /action="([^"]+)"/.exec(m[1]!)?.[1];
          expect(action, rel(f)).toBeDefined();
          actions.add(action!);
        }
      }
      expect([...actions].sort()).toEqual(['/auth/account/language-region', '/auth/account/profile', '/auth/active-role']);
    });
  });

  describe('form controls are labelled', () => {
    it('every input (not hidden) and select has an id and a <label htmlFor> with that id in the same file', () => {
      let controls = 0;
      for (const f of AREA_FILES.filter((x) => x.endsWith('.tsx'))) {
        const code = stripComments(read(rel(f)));
        for (const m of code.matchAll(/<(input|select)\b([^>]*?)\/?>/g)) {
          if (/type="hidden"/.test(m[2]!)) continue;
          controls++;
          const id = /\bid="([^"]+)"/.exec(m[2]!)?.[1];
          expect(id, `${rel(f)} ${m[0]}`).toBeDefined();
          expect(code, `${rel(f)} label for ${id}`).toContain(`<label htmlFor="${id}">`);
        }
      }
      expect(controls).toBe(4); // first name, last name, language, time zone
    });
    it('no placeholder stands in for a label, and no field is hidden from assistive technology', () => {
      for (const f of AREA_FILES.filter((x) => x.endsWith('.tsx')))
        expect(stripComments(read(rel(f))), rel(f)).not.toMatch(/placeholder=|aria-hidden=|tabIndex=\{?[1-9]/);
    });
    it('feedback regions: errors are role="alert" and notices role="status"', () => {
      const feedback = read('app/account/_components/feedback.tsx');
      expect(feedback).toContain('<p role="alert">{failure}</p>');
      expect(feedback).toContain('<p role="status">{done}</p>');
      expect(feedback).toContain('<p role="alert">{message}</p>');
    });
    it('the shell has the landmarks: a skip link to the content, a nav with an aria-label, a tabindex -1 content target', () => {
      const layout = read('app/account/layout.tsx');
      expect(layout).toContain('className="skip-link" href="#account-content"');
      expect(layout).toContain("'aria-label': navLabel");
      expect(layout).toContain('id="account-content"');
      expect(layout).toContain('tabIndex={-1}');
      expect(layout).not.toContain('<main'); // the root layout owns the one main landmark
      expect(read('app/layout.tsx').match(/<main\b/g)).toHaveLength(1);
    });
  });

  describe('routes', () => {
    const pageDirs = (): string[] =>
      walk(path.join(SRC, 'app/account'))
        .filter((f) => path.basename(f) === 'page.tsx')
        .map((f) => path.relative(path.join(SRC, 'app'), path.dirname(f)).split(path.sep).join('/'));
    it('each real section is its OWN static segment at the route the registry names, next to the home and one dynamic fallback', () => {
      const real = [
        ACCOUNT_SECTIONS.profile,
        ACCOUNT_SECTIONS.contactVerification,
        ACCOUNT_SECTIONS.security,
        ACCOUNT_SECTIONS.languageRegion,
        ACCOUNT_SECTIONS.privacyData,
        ACCOUNT_SECTIONS.roles,
      ];
      expect(pageDirs().sort()).toEqual(['account', 'account/[section]', ...real.map((c) => ROUTE_OF[c]!.slice(1))].sort());
      for (const c of real) expect(ROUTE_OF[c], c).toMatch(SECTION_ROUTE_PATTERN);
      // the planned ones have no static page: they fall to the dynamic route, which is a not-found
      for (const c of [ACCOUNT_SECTIONS.notifications, ACCOUNT_SECTIONS.closeAccount]) expect(pageDirs()).not.toContain(ROUTE_OF[c]!.slice(1));
    });
    it('the dynamic fallback does nothing but notFound()', () => {
      const code = stripComments(read('app/account/[section]/page.tsx'));
      expect(code).toContain('notFound();');
      expect(code).not.toMatch(/await|fetch|serverApi|headers\(/);
    });
    it('the BFF routes of the forms exist, POST only (a GET answers 405 through the handler)', () => {
      for (const name of ['profile', 'language-region']) {
        const code = read(`app/auth/account/${name}/route.ts`);
        expect(code).toContain('export const POST');
        expect(code).toContain(`'${name}'`);
        expect(code).toContain("export const dynamic = 'force-dynamic'");
      }
    });
    it('the pages are dynamic (per person) and the layout is too', () => {
      for (const f of AREA_FILES.filter((x) => /(page|layout)\.tsx$/.test(x))) expect(read(rel(f)), rel(f)).toContain("export const dynamic = 'force-dynamic'");
    });
  });

  describe('workspace boundaries', () => {
    it('the web app imports contracts only for the account area: no database, platform, accounts, geography, configuration or content package', () => {
      const FORBIDDEN =
        /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]@bananagig\/(database|platform|accounts|geography|configuration|content)(?:\/[^'"]*)?['"]/;
      const files = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('account-area-source.test.ts') && !f.endsWith('boundaries.test.ts'));
      expect(files.length).toBeGreaterThan(30);
      expect(files.filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([]);
      for (const f of AREA_FILES) {
        const imports = [...read(rel(f)).matchAll(/from\s+'(@bananagig\/[^']+)'/g)].map((m) => m[1]);
        for (const i of imports) expect(['@bananagig/contracts', '@bananagig/observability'], `${rel(f)} ${i}`).toContain(i);
      }
    });
  });
});

describe('the account area CSS', () => {
  const css = readFileSync(path.join(SRC, 'app/globals.css'), 'utf8');
  const area = css.slice(css.indexOf('/* Account area (ACC-001)'));
  /** A selector list split at its top-level commas (the commas inside :is(...) belong to the selector). */
  const splitSelectors = (list: string): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of list) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(current.trim());
        current = '';
      } else current += ch;
    }
    return [...parts, current.trim()];
  };
  /** Rules as { selectors, declarations }, with the media query they sit in (null at top level). */
  const rules = (() => {
    const out: { media: string | null; selectors: string[]; body: string }[] = [];
    const walkBlock = (text: string, media: string | null): void => {
      const re = /([^{}]+)\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
      for (const m of text.matchAll(re)) {
        const head = m[1]!.trim();
        if (head.startsWith('@media')) walkBlock(m[2]!, head);
        else out.push({ media, selectors: splitSelectors(head), body: m[2]!.trim() });
      }
    };
    walkBlock(area.replace(/\/\*[\s\S]*?\*\//g, ''), null);
    return out;
  })();
  /** The same for the whole file (the rules of the app the shell inherits). */
  const globalRules = (() => {
    const out: { selectors: string[]; body: string }[] = [];
    for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}@]+)\{([^{}]*)\}/g))
      out.push({ selectors: splitSelectors(m[1]!.trim()), body: m[2]!.trim() });
    return out;
  })();
  const declared = (selector: string, property: string): string | undefined => {
    for (const r of rules) if (r.selectors.includes(selector)) return new RegExp(`${property}:\\s*([^;]+)`).exec(r.body)?.[1]?.trim();
    return undefined;
  };

  it('every interactive target (links, buttons, selects, text inputs) of the shell is at least 44x44 CSS px', () => {
    const target = rules.find((r) => r.selectors.includes(".account-shell :is(a, button, select, input:not([type='hidden']))"));
    expect(target).toBeDefined();
    expect(target!.body).toMatch(/min-height:\s*44px/);
    expect(target!.body).toMatch(/min-width:\s*44px/);
    expect(target!.media).toBeNull();
    // inline links ignore min-height: the rule that makes them boxes
    expect(declared('.account-shell :is(.account-back, .account-link)', 'display')).toBe('inline-flex');
    // the menu links are blocks (flex) so the whole row is the target
    expect(declared('.account-nav-list a', 'display')).toBe('flex');
  });
  it('focus is visible on every control of the shell and never removed from one', () => {
    const focus = rules.find((r) => r.selectors.includes('.account-shell :is(a, button, select, input):focus-visible'));
    expect(focus).toBeDefined();
    expect(focus!.body).toMatch(/outline:\s*3px solid var\(--fg\)/);
    for (const r of rules) {
      if (!/outline:\s*(none|0)\b/.test(r.body)) continue;
      // the only exception is the content container, which takes focus from the skip link (tabindex -1): not a control
      expect(r.selectors, r.body).toEqual(['.account-content:focus']);
    }
    // the global rule of the app still covers the shell's links and buttons
    const global = globalRules.find((r) => r.selectors.includes('a:focus-visible') && r.selectors.includes('button:focus-visible'));
    expect(global?.body).toMatch(/outline:\s*3px solid var\(--fg\)/);
  });
  it('nothing depends on hover: every :hover selector is paired with :focus-visible in the same rule, and none hides or reveals content', () => {
    let hovers = 0;
    for (const r of rules) {
      if (!r.selectors.some((s) => s.includes(':hover'))) continue;
      hovers++;
      for (const s of r.selectors.filter((x) => x.includes(':hover'))) expect(r.selectors, s).toContain(s.replace(':hover', ':focus-visible'));
      expect(r.body).not.toMatch(/display:\s*none|visibility:\s*hidden|opacity:\s*0\b/);
    }
    expect(hovers).toBeGreaterThan(0);
  });
  it('is mobile first: one column by default, the sidebar layout only from a min-width query; no max-width query', () => {
    expect(area).not.toMatch(/@media[^{]*max-width/);
    expect(area).toMatch(/@media \(min-width: 48em\)/);
    expect(declared('.account-shell', 'display')).toBe('grid');
    expect(rules.find((r) => r.media === null && r.selectors.includes('.account-shell'))!.body).not.toMatch(/grid-template-columns/);
    const wide = rules.filter((r) => r.media === '@media (min-width: 48em)');
    expect(wide.find((r) => r.selectors.includes('.account-shell'))!.body).toMatch(/grid-template-columns:\s*16rem minmax\(0, 1fr\)/);
    // a phone shows the menu or the section, not both; a wide screen shows the menu always and hides the link back
    expect(rules.find((r) => r.media === null && r.selectors.includes(".account-shell:has([data-view='section']) .account-nav"))!.body).toMatch(
      /display:\s*none/,
    );
    expect(wide.find((r) => r.selectors.includes(".account-shell:has([data-view='section']) .account-nav"))!.body).toMatch(/display:\s*block/);
    expect(wide.find((r) => r.selectors.includes('.account-shell .account-back'))!.body).toMatch(/display:\s*none/);
  });
  // ---- contrast (WCAG 1.4.3 text 4.5:1, 1.4.11 non-text 3:1), computed from the theme tokens of :root in both colour schemes
  const parseTokens = (body: string): Record<string, string> =>
    Object.fromEntries([...body.matchAll(/(--[a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
  const roots = [...css.matchAll(/:root\s*\{([^{}]*)\}/g)].map((m) => parseTokens(m[1]!));
  const SCHEMES = { light: roots[0]!, dark: { ...roots[0]!, ...roots[1]! } } as const;
  const luminance = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  it('the theme tokens are read (a light and a dark scheme) and the contrast helper agrees with known values', () => {
    expect(roots).toHaveLength(2);
    expect(SCHEMES.light['--fg']).toBe('#1b1b1b');
    expect(SCHEMES.dark['--bg']).toBe('#151410');
    expect(SCHEMES.dark['--accent']).toBe(SCHEMES.light['--accent']); // the accent is the same yellow in both schemes
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });
  it('links in the account area take the theme text colour (visited too) instead of the browser blue / purple, which fail on the dark background; the skip link keeps its own inverted colours', () => {
    const link = globalRules.find(
      (r) => r.selectors.includes('.account-shell a:not(.skip-link):link') && r.selectors.includes('.account-shell a:not(.skip-link):visited'),
    );
    expect(link, 'a rule for :link and :visited anchors of the shell').toBeDefined();
    expect(link!.body).toMatch(/color:\s*var\(--fg\)/);
    // the content links are underlined, so they are not told apart by colour alone
    expect(declared('.account-shell :is(.account-back, .account-link)', 'text-decoration')).toBe('underline');
    // the menu links do not override it with a colour of their own
    for (const r of rules.filter((x) => x.selectors.some((s) => s.startsWith('.account-nav-list a'))))
      for (const m of r.body.matchAll(/(?:^|[;\s])color:\s*([^;\s]+)/g)) expect(['inherit', 'var(--fg)']).toContain(m[1]);
    // the numbers: the text colour on the page background in light and dark, against the default link colours it replaces
    for (const [scheme, t] of Object.entries(SCHEMES)) expect(contrast(t['--fg']!, t['--bg']!), scheme).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#0000ee', SCHEMES.dark['--bg']!), 'default link colour on the dark background').toBeLessThan(4.5);
    expect(contrast('#551a8b', SCHEMES.dark['--bg']!), 'default visited colour on the dark background').toBeLessThan(4.5);
    // the global rule for links outside the area is untouched: nothing but the shell is coloured here
    expect(globalRules.filter((r) => r !== link && r.selectors.some((s) => /^a(:|$)/.test(s)) && /(^|;|\s)color:/.test(r.body))).toEqual([]);
  });
  it('the muted text and the badge border of the area keep their contrast in both schemes', () => {
    for (const [scheme, t] of Object.entries(SCHEMES)) {
      expect(contrast(t['--muted']!, t['--bg']!), `muted text ${scheme}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--fg']!, t['--bg']!), `bar ${scheme}`).toBeGreaterThanOrEqual(3);
    }
  });
  it('the current page is marked by more than colour: bold, an underlined label and a bar in the text colour (not the 1.6:1 accent), styled from aria-current', () => {
    const current = rules.find((r) => r.selectors.includes(".account-nav-list a[aria-current='page']"));
    expect(current!.body).toMatch(/font-weight:\s*700/);
    expect(current!.body).toMatch(/border-inline-start-color:\s*var\(--fg\)/);
    expect(current!.body).not.toContain('--accent');
    expect(declared(".account-nav-list a[aria-current='page'] .account-nav-label", 'text-decoration')).toBe('underline');
    // the bar is wide enough to see and in the text colour: it meets 3:1 in both schemes, where the accent yellow does not in light
    expect(declared('.account-nav-list a', 'border-inline-start')).toMatch(/^4px solid transparent$/);
    expect(contrast(SCHEMES.light['--accent']!, SCHEMES.light['--bg']!)).toBeLessThan(3);
    for (const [scheme, t] of Object.entries(SCHEMES)) expect(contrast(t['--fg']!, t['--bg']!), scheme).toBeGreaterThanOrEqual(3);
  });
  it('uses the theme variables only (works in dark mode) and no new framework', () => {
    expect(area).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(area).not.toMatch(/@import|@tailwind|@apply/);
  });
});
