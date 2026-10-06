# ADR-0019 — Restricted template formatter and zero-dependency markup renderer

Status: ACCEPTED
Date: 2026-10-06
Checkpoint: CFG-002

## Context

Content bodies contain variables (names, counts, money, dates, links) and, for email, help and legal copy, light formatting. Authors are staff and translators, and later possibly an admin UI; variable values come from application code and, indirectly, from users (a display name, a URL). The rendered output goes into emails, push messages and web pages. The template language and the markup renderer are therefore a security boundary: a template must never reach code, loops or unintended data, and no author text or variable value may produce active HTML.

## Decision

Two small components, written in this repository with no third-party code, in `packages/content/src`.

**Restricted template formatter** (`template.ts`, `format.ts`). Source is literal text, `{name}` placeholders, `{{` and `}}` for literal braces, and exactly one construct `{name, plural, one {..} other {..}}` (categories zero, one, two, few, many, other; `other` required; only on COUNT variables; branches hold text, `{var}` and `#`; no nesting). There are no expressions, helpers, includes, loops, conditions, select or inline format arguments. The source is parsed into a small AST and rendered by pure functions; values are formatted by variable type (STRING, PERSON_DISPLAY_NAME, URL, NUMBER, COUNT, MONEY, DATE, TIME, DATETIME) with `Intl` and the resolved locale, and are never re-interpreted as template. Money is built from minor units with BigInt, never floats. Dates render in UTC (DATE, TIME) or a validated IANA zone (DATETIME). Limits: 200000 characters, 200 placeholders, 500 characters for single-line types, checked on the source and again on the rendered output (render-time overflow is `TEMPLATE_ERROR` reason `LIMIT`, details `{limit: 500, rendered: true}`). Control characters (C0 other than TAB, LF and CR, and DEL with the C1 range U+007F to U+009F including NEL), line and paragraph separators, bidirectional controls and the internal placeholder sentinels are rejected in sources and values. Single-line types collapse whitespace, the C1 controls and U+2028 and U+2029 to one space and trim, so no CR, LF or other Unicode line terminator can reach an email subject.

**Zero-dependency markup renderer** (`markup.ts`). A restricted Markdown subset (paragraphs, three heading levels, bullet and ordered lists, blockquotes, strong, emphasis, code, links, backslash escapes) is parsed into an AST and HTML is generated only from that AST with every text node escaped. Output tags are `p br strong em code a ul ol li blockquote h2 h3 h4`; attributes are `href` and `rel` on `a`. Raw HTML is not recognized: it is escaped text. Links are limited to https, http, mailto, tel and root-relative paths, validated at authoring (`UNSAFE_LINK`) and again at render time for variable-built destinations; absolute http(s) links get `rel="noopener noreferrer nofollow"`; nothing is ever decoded before checking. Variable values are substituted after parsing (private-use sentinels in the intermediate string) as escaped text or validated destinations, so a value cannot introduce markup. `assertSafeHtml` re-tokenizes every output against the allow-list as defense in depth. Scanning is linear and nesting is bounded.

**Authoring validation** parses the body, checks variables and content-type rules, and dry-renders it with each variable's example, so unsafe or broken copy never reaches the database. The dry render runs in at most `max(1, largest category count of any plural construct)` full rounds (at most 6, however many constructs the body has): round r forces every plural construct to its r-th available category, a construct with fewer categories reuses its last, so every branch is rendered and verified (HTML allow-list for markup types, the 500-character limit for single-line types) at least once. The cost is O(rounds x body size), not O(constructs x categories x body size).

## Alternatives considered

- **ICU MessageFormat** (full): select, nested plural, number and date arguments, and custom argument styles expand the surface translators can reach and need a large parser; we need one plural construct and typed values. The restricted subset is compatible in spirit, and a later move to a vetted ICU parser stays possible because stored bodies use a subset of its syntax.
- **Handlebars, Mustache, Liquid**: helpers, partials, lookups and loops (and, in Handlebars, a history of prototype-access and denial-of-service issues) turn a copy editor into a code author; output is not escaped by type; locale-aware plural and money formatting would still be custom.
- **sanitize-html, DOMPurify, marked or markdown-it**: they sanitize or parse arbitrary HTML. Our problem is smaller: generate HTML from a known grammar. A sanitizer is a deny-by-default filter over a hostile input format and a source of mutation-XSS and configuration drift; a Markdown library emits raw HTML by default and adds plugins. Neither removes the need for our own variable substitution rules and allow-list verifier. Dependencies also enlarge the audit surface (`pnpm audit --prod`).
- **Allowing raw HTML from trusted authors**: removes the guarantee that all output is safe; trust in authors is exactly what an approval workflow cannot prove.
- **Sanitizing only at render time**: a bad draft would be discovered by users; validating at authoring catches it before approval.

## Consequences

The language is limited by design: no conditionals, no select, no images, no tables, no raw HTML, no formatting arguments. Copy needing more must be restructured (separate entries per case) or the language extended through a new ADR. The parser and renderer are our code to maintain, with a vector corpus in `markup.test.ts` and parser and renderer unit tests in `template.test.ts` and `format.test.ts`; correctness of CLDR plural rules and number formats depends on the Node runtime's ICU data. Callers must still escape `format: "text"` output (React does) and inject only `format: "html"` values. Errors carry positions and reasons, never copy or values.

## Migration / compatibility

No schema impact beyond the length and character CHECKs in `0005_content_registry.sql`. Stored bodies use only the documented subset; widening the language later is backward compatible, narrowing it is not.

## Related files

- `packages/content/src/template.ts`
- `packages/content/src/format.ts`
- `packages/content/src/markup.ts`
- `packages/content/src/markup.test.ts`
- `docs/engineering/CONTENT.md`
