// A small shell tokenizer/parser plus command normalisation, shared by the Bash guard and the verification recorder (ENG-GOV-001).
// It is NOT a full POSIX shell. It covers what is needed to decide on simple commands: quotes (including ANSI-C $'...'), escapes,
// ; && || | |& & newlines, ( ) groups, $(...) / backtick / <(...) substitutions as nested command lists, brace expansion, redirections,
// here-documents (quoted and unquoted) and here-strings, comments, leading VAR=x assignments, reserved-word prefixes and wrappers.
import path from 'node:path';

const MAX_DEPTH = 6;
const MAX_BRACE_WORDS = 128;
export class ShellParseError extends Error {}

function newSeg(subs) {
  return {
    words: [],
    redirects: [],
    heredocs: [],
    subst: [],
    subs,
    op: '',
    dynamic: false,
    background: false,
    braceOverflow: false,
  };
}

/** Parse `src` into a list of simple-command segments (each with nested `subst` lists). Throws ShellParseError. */
export function parseShell(src, depth = 0) {
  if (depth > MAX_DEPTH) throw new ShellParseError('commands nested too deeply');
  const p = { s: String(src), i: 0, subs: [] };
  return parseList(p, depth, null);
}

/** Substitution placeholders look like $(...#3) / <(...#3) / `...#3`; this finds the nested list a placeholder refers to. */
export function placeholderList(seg, word) {
  const m = /^(?:\$\(|<\(|>\(|`)\.\.\.#(\d+)(?:\)|`)$/.exec(String(word));
  return m ? (seg.subs[Number(m[1])] ?? null) : null;
}
export const hasPlaceholder = (word) => /(?:\$\(|<\(|>\(|`)\.\.\.#\d+[)`]?/.test(String(word));

function skipArith(p) {
  // p.i is at "$((": copy up to the matching "))" as text.
  let level = 0;
  const start = p.i;
  while (p.i < p.s.length) {
    const c = p.s[p.i];
    if (c === '(') level += 1;
    else if (c === ')') {
      level -= 1;
      if (level === 0) {
        p.i += 1;
        return p.s.slice(start, p.i);
      }
    }
    p.i += 1;
  }
  throw new ShellParseError('unterminated arithmetic expansion');
}

function readBrace(p) {
  // p.i is at "${": copy up to the matching "}".
  let level = 0;
  const start = p.i;
  while (p.i < p.s.length) {
    const c = p.s[p.i];
    if (c === '{') level += 1;
    else if (c === '}') {
      level -= 1;
      if (level === 0) {
        p.i += 1;
        return p.s.slice(start, p.i);
      }
    }
    p.i += 1;
  }
  throw new ShellParseError('unterminated ${...}');
}

function readBacktick(p, depth) {
  // p.i is at the opening backtick.
  let inner = '';
  p.i += 1;
  while (p.i < p.s.length) {
    const c = p.s[p.i];
    if (c === '\\' && p.i + 1 < p.s.length) {
      const n = p.s[p.i + 1];
      inner += n === '`' || n === '\\' || n === '$' ? n : `\\${n}`;
      p.i += 2;
      continue;
    }
    if (c === '`') {
      p.i += 1;
      return parseShell(inner, depth + 1);
    }
    inner += c;
    p.i += 1;
  }
  throw new ShellParseError('unterminated backtick substitution');
}

/** Command substitutions inside an UNQUOTED here-document body are executed by the shell: return their nested lists. */
function scanExpansions(body, depth) {
  const lists = [];
  const p = { s: body, i: 0, subs: [] };
  while (p.i < body.length) {
    const c = body[p.i];
    if (c === '\\') {
      p.i += 2;
    } else if (c === '$' && body[p.i + 1] === '(') {
      if (body[p.i + 2] === '(') skipArith(p);
      else {
        p.i += 2;
        lists.push(parseList(p, depth + 1, ')'));
      }
    } else if (c === '`') {
      lists.push(readBacktick(p, depth));
    } else {
      p.i += 1;
    }
  }
  return lists;
}

/** Decode the body of an ANSI-C quoted string $'...'. p.i is just after the opening quote; leaves p.i after the closing quote. */
function readAnsiC(p) {
  const s = p.s;
  let out = '';
  while (p.i < s.length) {
    const c = s[p.i];
    if (c === "'") {
      p.i += 1;
      return out;
    }
    if (c !== '\\') {
      out += c;
      p.i += 1;
      continue;
    }
    const n = s[p.i + 1];
    p.i += 2;
    if (n === undefined) break;
    const simple = {
      a: '\x07',
      b: '\b',
      e: '\x1b',
      E: '\x1b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      '\\': '\\',
      "'": "'",
      '"': '"',
      '?': '?',
    };
    if (n in simple) {
      out += simple[n];
    } else if (n >= '0' && n <= '7') {
      let digits = n;
      while (digits.length < 3 && s[p.i] >= '0' && s[p.i] <= '7') {
        digits += s[p.i];
        p.i += 1;
      }
      out += String.fromCharCode(parseInt(digits, 8) & 0xff);
    } else if (n === 'x' || n === 'u' || n === 'U') {
      const max = n === 'x' ? 2 : n === 'u' ? 4 : 8;
      let digits = '';
      while (digits.length < max && /[0-9a-fA-F]/.test(s[p.i] ?? '')) {
        digits += s[p.i];
        p.i += 1;
      }
      if (digits) {
        try {
          out += String.fromCodePoint(parseInt(digits, 16));
        } catch {
          out += '?';
        }
      } else out += `\\${n}`;
    } else if (n === 'c') {
      out += String.fromCharCode((s.charCodeAt(p.i) ?? 0) & 0x1f);
      p.i += 1;
    } else {
      out += `\\${n}`;
    }
  }
  throw new ShellParseError("unterminated $'...' string");
}

// ---- brace expansion ------------------------------------------------------------------------------------------------

function splitTopLevel(inner) {
  const parts = [];
  let level = 0;
  let cur = '';
  for (const c of inner) {
    if (c === '{') level += 1;
    else if (c === '}') level -= 1;
    if (c === ',' && level === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  return parts;
}

function rangeItems(inner) {
  const num = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(inner);
  if (num) {
    const a = Number(num[1]);
    const b = Number(num[2]);
    const step = Math.abs(Number(num[3] ?? 1)) || 1;
    if (Math.abs(b - a) / step > MAX_BRACE_WORDS) return 'overflow';
    const items = [];
    for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? step : -step) items.push(String(v));
    return items;
  }
  const chr = /^([a-zA-Z])\.\.([a-zA-Z])$/.exec(inner);
  if (chr) {
    const a = chr[1].charCodeAt(0);
    const b = chr[2].charCodeAt(0);
    const items = [];
    for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? 1 : -1) items.push(String.fromCharCode(v));
    return items;
  }
  return null;
}

/** Bash-style brace expansion. Returns { words } (expanded) | { overflow: true } | null when the word has no brace expression. */
export function braceExpand(str) {
  const open = str.indexOf('{');
  for (let i = open; i >= 0 && i < str.length; i = str.indexOf('{', i + 1)) {
    let level = 0;
    let close = -1;
    for (let j = i; j < str.length; j += 1) {
      if (str[j] === '{') level += 1;
      else if (str[j] === '}') {
        level -= 1;
        if (level === 0) {
          close = j;
          break;
        }
      }
    }
    if (close < 0) return null;
    const inner = str.slice(i + 1, close);
    let alts = null;
    const parts = splitTopLevel(inner);
    if (parts.length > 1) alts = parts;
    else {
      const r = rangeItems(inner);
      if (r === 'overflow') return { overflow: true };
      alts = r;
    }
    if (!alts) continue;
    const prefix = str.slice(0, i);
    const suffix = str.slice(close + 1);
    const words = [];
    for (const alt of alts) {
      const sub = braceExpand(prefix + alt + suffix);
      if (sub && sub.overflow) return sub;
      if (sub) words.push(...sub.words);
      else words.push(prefix + alt + suffix);
      if (words.length > MAX_BRACE_WORDS) return { overflow: true };
    }
    return { words };
  }
  return null;
}

// ---- the parser -----------------------------------------------------------------------------------------------------

function parseList(p, depth, closer) {
  if (depth > MAX_DEPTH) throw new ShellParseError('commands nested too deeply');
  const s = p.s;
  const segs = [];
  let cur = newSeg(p.subs);
  let word = null;
  let wordQuoted = false;
  let braceFlag = false;
  let nextOp = '';
  let parenDepth = 0;
  let pendingRedirect = null;
  const pendingHeredocs = [];

  const addSub = (list) => {
    p.subs.push(list);
    cur.subst.push(list);
    cur.dynamic = true;
    return p.subs.length - 1;
  };
  const endWord = () => {
    if (word === null) return;
    let words = [word];
    if (braceFlag) {
      const ex = braceExpand(word);
      if (ex && ex.overflow) {
        cur.braceOverflow = true;
        cur.dynamic = true;
      } else if (ex) words = ex.words;
    }
    if (pendingRedirect) {
      cur.redirects.push({ op: pendingRedirect, target: words[0] });
      if (pendingRedirect === '<<' || pendingRedirect === '<<-')
        pendingHeredocs.push({
          seg: cur,
          delim: words[0],
          strip: pendingRedirect === '<<-',
          quoted: wordQuoted,
        });
      pendingRedirect = null;
    } else {
      cur.words.push(...words);
    }
    word = null;
    wordQuoted = false;
    braceFlag = false;
  };
  const endCommand = (op) => {
    endWord();
    pendingRedirect = null;
    if (cur.words.length || cur.redirects.length || cur.subst.length) {
      cur.op = nextOp;
      cur.background = op === '&';
      segs.push(cur);
    }
    nextOp = op;
    cur = newSeg(p.subs);
  };
  const readHeredocBodies = () => {
    for (const h of pendingHeredocs) {
      const lines = [];
      for (;;) {
        if (p.i >= s.length) break;
        let nl = s.indexOf('\n', p.i);
        if (nl < 0) nl = s.length;
        const line = s.slice(p.i, nl);
        p.i = Math.min(nl + 1, s.length);
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        lines.push(line);
      }
      const body = lines.join('\n');
      h.seg.heredocs.push(body);
      if (!h.quoted) {
        // an unquoted delimiter means the body undergoes expansion: $(...) and backticks inside it RUN
        for (const list of scanExpansions(body, depth)) {
          p.subs.push(list);
          h.seg.subst.push(list);
          h.seg.dynamic = true;
        }
      }
    }
    pendingHeredocs.length = 0;
  };
  const substitution = () => {
    // p.i at "$(" or "<(" / ">(": parse the inner list up to the matching ")".
    const kind = s[p.i];
    p.i += 2;
    const inner = parseList(p, depth + 1, ')');
    const id = addSub(inner);
    return `${kind === '$' ? '$(' : `${kind}(`}...#${id})`;
  };

  while (p.i < s.length) {
    const c = s[p.i];
    if (c === '\\') {
      const n = s[p.i + 1];
      if (n === undefined) {
        p.i += 1;
      } else if (n === '\n') {
        p.i += 2;
      } else {
        word = (word ?? '') + n;
        wordQuoted = true;
        p.i += 2;
      }
      continue;
    }
    if (c === "'") {
      const j = s.indexOf("'", p.i + 1);
      if (j < 0) throw new ShellParseError('unterminated single quote');
      word = (word ?? '') + s.slice(p.i + 1, j);
      wordQuoted = true;
      p.i = j + 1;
      continue;
    }
    if (c === '"') {
      p.i += 1;
      wordQuoted = true;
      let buf = word ?? '';
      for (;;) {
        if (p.i >= s.length) throw new ShellParseError('unterminated double quote');
        const d = s[p.i];
        if (d === '"') {
          p.i += 1;
          break;
        }
        if (d === '\\') {
          const n = s[p.i + 1];
          if (n === '$' || n === '`' || n === '"' || n === '\\') {
            buf += n;
            p.i += 2;
          } else if (n === '\n') {
            p.i += 2;
          } else {
            buf += '\\';
            p.i += 1;
          }
          continue;
        }
        if (d === '$' && s[p.i + 1] === '(') {
          if (s[p.i + 2] === '(') buf += skipArith(p);
          else buf += substitution();
          continue;
        }
        if (d === '$' && s[p.i + 1] === '{') {
          buf += readBrace(p);
          cur.dynamic = true;
          continue;
        }
        if (d === '`') {
          const id = addSub(readBacktick(p, depth));
          buf += `\`...#${id}\``;
          continue;
        }
        buf += d;
        p.i += 1;
      }
      word = buf;
      continue;
    }
    if (c === '$') {
      const n = s[p.i + 1];
      if (n === '(') {
        if (s[p.i + 2] === '(') word = (word ?? '') + skipArith(p);
        else word = (word ?? '') + substitution();
        continue;
      }
      if (n === '{') {
        word = (word ?? '') + readBrace(p);
        cur.dynamic = true;
        continue;
      }
      if (n === "'") {
        p.i += 2;
        word = (word ?? '') + readAnsiC(p);
        wordQuoted = true;
        continue;
      }
      word = (word ?? '') + c;
      p.i += 1;
      continue;
    }
    if (c === '`') {
      const id = addSub(readBacktick(p, depth));
      word = (word ?? '') + `\`...#${id}\``;
      continue;
    }
    if ((c === '<' || c === '>') && s[p.i + 1] === '(') {
      word = (word ?? '') + substitution();
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      p.i += 1;
      continue;
    }
    if (c === '\n') {
      endWord();
      p.i += 1;
      readHeredocBodies();
      endCommand('\n');
      continue;
    }
    if (c === '#' && word === null) {
      while (p.i < s.length && s[p.i] !== '\n') p.i += 1;
      continue;
    }
    if (c === ';') {
      p.i += s[p.i + 1] === ';' || s[p.i + 1] === '&' ? 2 : 1;
      endCommand(';');
      continue;
    }
    if (c === '&') {
      if (s[p.i + 1] === '&') {
        p.i += 2;
        endCommand('&&');
        continue;
      }
      if (s[p.i + 1] === '>') {
        endWord();
        const op = s[p.i + 2] === '>' ? '&>>' : '&>';
        p.i += op.length;
        pendingRedirect = op;
        continue;
      }
      p.i += 1;
      endCommand('&');
      continue;
    }
    if (c === '|') {
      if (s[p.i + 1] === '|') {
        p.i += 2;
        endCommand('||');
      } else {
        p.i += s[p.i + 1] === '&' ? 2 : 1;
        endCommand('|');
      }
      continue;
    }
    if (c === '<' || c === '>') {
      if (word !== null && /^\d+$/.test(word)) {
        word = null;
        wordQuoted = false;
        braceFlag = false;
      } else endWord();
      const m = /^(?:<<<|<<-|<<|<>|<&|<|>>|>&|>\||>)/.exec(s.slice(p.i, p.i + 3));
      const op = m[0];
      p.i += op.length;
      pendingRedirect = op;
      continue;
    }
    if (c === '(') {
      parenDepth += 1;
      p.i += 1;
      endCommand(';');
      continue;
    }
    if (c === ')') {
      p.i += 1;
      if (parenDepth > 0) {
        parenDepth -= 1;
        endCommand(';');
      } else if (closer === ')') {
        endCommand('');
        return segs;
      } else {
        endCommand(';');
      }
      continue;
    }
    if (c === '{') braceFlag = true;
    word = (word ?? '') + c;
    p.i += 1;
  }
  if (closer === ')') throw new ShellParseError('unterminated command substitution');
  endCommand('');
  // here-document bodies that never got a newline are empty
  for (const h of pendingHeredocs) h.seg.heredocs.push('');
  return segs;
}

// ---- wrappers, assignments, command info ----------------------------------------------------------------------------

const RESERVED_PREFIX = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time', 'coproc', 'function']);
export const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'csh', 'tcsh']);
export const base = (w) => path.posix.basename(String(w));

const skipOptions = (w, start, valueOpts = []) => {
  let i = start;
  while (i < w.length && w[i].startsWith('-') && w[i] !== '-') {
    if (w[i] === '--') return i + 1;
    i += valueOpts.includes(w[i]) ? 2 : 1;
  }
  return i;
};

/** Strip reserved words, leading assignments and wrappers (env, sudo, command, nohup, timeout, xargs, ssh, ...). */
export function commandInfo(seg) {
  let w = seg.words.slice();
  const env = {};
  const scripts = [];
  let shellStdin = false;
  let wrapperFlags = [];
  const stripLeading = () => {
    for (;;) {
      while (w.length && RESERVED_PREFIX.has(w[0])) {
        // `function name {` : the function keyword, its name and the opening brace are not the command
        if (w[0] === 'function' && w.length > 2 && w[2] === '{') w.splice(0, 2);
        else if (w[0] === 'function' && w.length > 1) w.splice(0, 2);
        else w.shift();
      }
      if (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) {
        const eq = w[0].indexOf('=');
        env[w[0].slice(0, eq)] = w[0].slice(eq + 1);
        w.shift();
        continue;
      }
      return;
    }
  };
  stripLeading();
  for (let guard = 0; guard < 12 && w.length; guard += 1) {
    const name = base(w[0]);
    let i = 1;
    if (name === 'env') {
      while (i < w.length) {
        const x = w[i];
        if (x === '--') {
          i += 1;
          break;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(x)) {
          const eq = x.indexOf('=');
          env[x.slice(0, eq)] = x.slice(eq + 1);
          i += 1;
        } else if (x === '-u' || x === '-C' || x === '--unset' || x === '--chdir') i += 2;
        else if (x === '-S' || x === '--split-string') {
          if (w[i + 1] !== undefined) scripts.push(w[i + 1]);
          i = w.length;
        } else if (x.startsWith('-')) i += 1;
        else break;
      }
      w = w.slice(i);
    } else if (name === 'sudo' || name === 'doas') {
      while (i < w.length && w[i].startsWith('-')) {
        if (w[i] === '--') {
          i += 1;
          break;
        }
        i += /^-[ughpCrtUDRTac]$/.test(w[i]) ? 2 : 1;
      }
      w = w.slice(i);
    } else if (name === 'su') {
      const c = w.indexOf('-c');
      if (c > 0 && w[c + 1] !== undefined) scripts.push(w[c + 1]);
      break;
    } else if (name === 'command' || name === 'builtin') {
      if (w.slice(1).some((x) => x === '-v' || x === '-V')) {
        w = [];
        break;
      }
      i = skipOptions(w, 1);
      w = w.slice(i);
    } else if (name === 'exec') {
      i = skipOptions(w, 1, ['-a']);
      w = w.slice(i);
    } else if (['nohup', 'time', 'setsid', 'unbuffer', 'caffeinate', 'stdbuf'].includes(name)) {
      i = skipOptions(w, 1);
      w = w.slice(i);
    } else if (name === 'nice' || name === 'ionice') {
      i = skipOptions(w, 1, ['-n', '-N', '-c', '-p']);
      w = w.slice(i);
    } else if (name === 'arch') {
      i = skipOptions(w, 1, ['-d', '-e']);
      w = w.slice(i);
    } else if (name === 'xcrun') {
      i = skipOptions(w, 1, ['--sdk', '-sdk', '--toolchain', '-toolchain', '-k', '--kill-cache']);
      w = w.slice(i);
    } else if (name === 'timeout') {
      i = skipOptions(w, 1, ['-s', '-k']);
      w = w.slice(i + 1); // skip DURATION
    } else if (name === 'flock') {
      i = skipOptions(w, 1, ['-w', '-E', '-c']);
      const c = w.indexOf('-c');
      if (c > 0 && w[c + 1] !== undefined) {
        scripts.push(w[c + 1]);
        break;
      }
      w = w.slice(i + 1); // skip the lock file
    } else if (name === 'chroot') {
      i = skipOptions(w, 1, ['--userspec', '--groups']);
      w = w.slice(i + 1); // skip NEWROOT
    } else if (name === 'watch') {
      i = skipOptions(w, 1, ['-n', '--interval', '-d']);
      if (w.slice(i).length) scripts.push(w.slice(i).join(' '));
      break;
    } else if (name === 'ssh') {
      i = skipOptions(w, 1, ['-p', '-i', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-E', '-b', '-c', '-e', '-m', '-O', '-S', '-W', '-w', '-B', '-I', '-Q']);
      if (w.slice(i + 1).length) scripts.push(w.slice(i + 1).join(' ')); // everything after the host runs on the remote shell
      break;
    } else if (name === 'xargs') {
      wrapperFlags = [...wrapperFlags, 'xargs'];
      i = skipOptions(w, 1, ['-I', '-J', '-n', '-P', '-L', '-s', '-E', '-d']);
      w = w.slice(i);
    } else if (name === 'npx' || name === 'pnpx' || name === 'bunx') {
      i = skipOptions(w, 1, ['-p', '--package']);
      w = w.slice(i);
    } else if (SHELLS.has(name)) {
      let cFlag = false;
      while (i < w.length && (w[i].startsWith('-') || w[i].startsWith('+'))) {
        if (w[i] === '--') {
          i += 1;
          break;
        }
        if (['-o', '+o', '-O', '+O', '--rcfile', '--init-file', '--startup-file', '--init-command'].includes(w[i])) {
          i += 2;
          continue;
        }
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(w[i])) cFlag = true;
        i += 1;
      }
      if (cFlag && w[i] !== undefined) scripts.push(w[i]);
      else if (!cFlag) shellStdin = true;
      break;
    } else if (name === 'eval') {
      scripts.push(w.slice(1).join(' '));
      break;
    } else if (name === 'pnpm' || name === 'npm' || name === 'yarn') {
      const t = pkgScript(name, w.slice(1));
      if (t.kind === 'exec' || t.kind === 'dlx') {
        w = t.rest;
        continue;
      }
      break;
    } else {
      break;
    }
    stripLeading();
  }
  const cmd = w.length ? base(w[0]) : '';
  return {
    cmd,
    args: w.slice(1),
    words: w,
    env,
    scripts,
    shellStdin,
    wrapperFlags,
  };
}

// ---- option scanning ------------------------------------------------------------------------------------------------

/**
 * Generic option scanner. valueLong: long options taking a separate value; valueShortNext: short letters taking a value;
 * attachedShort: letters consuming the rest of the cluster; canon(name) -> canonical long name | null (null = unknown option,
 * recorded in `unknown`).
 */
export function scanFlags(args, { valueLong = [], valueShortNext = '', attachedShort = '', canon = null } = {}) {
  const long = new Map();
  const short = new Set();
  const positional = [];
  const afterDD = [];
  const unknown = [];
  let dd = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (dd) {
      afterDD.push(a);
      continue;
    }
    if (a === '--') {
      dd = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (canon) {
        const c = canon(name);
        if (c === null) unknown.push(a);
        else name = c;
      }
      if (eq >= 0) long.set(name, a.slice(eq + 1));
      else if (valueLong.includes(name) && i + 1 < args.length) {
        i += 1;
        long.set(name, args[i]);
      } else long.set(name, true);
      continue;
    }
    if (a.length > 1 && a.startsWith('-')) {
      for (let k = 1; k < a.length; k += 1) {
        const ch = a[k];
        if (valueShortNext.includes(ch)) {
          if (k === a.length - 1 && i + 1 < args.length) i += 1;
          break;
        }
        short.add(ch);
        if (attachedShort.includes(ch)) break;
      }
      continue;
    }
    positional.push(a);
  }
  return {
    long,
    short,
    positional,
    afterDD,
    unknown,
    all: [...positional, ...afterDD],
  };
}

const PKG_VALUE_LONG = [
  'filter',
  'filter-prod',
  'dir',
  'prefix',
  'workspace',
  'cwd',
  'registry',
  'reporter',
  'loglevel',
  'use-node-version',
  'workspace-concurrency',
  'config',
];

/** Interpret `pnpm|npm|yarn [global opts] [run|exec|dlx] <target> ...`. */
export function pkgScript(cmd, args) {
  const f = scanFlags(args, { valueLong: PKG_VALUE_LONG, valueShortNext: cmd === 'npm' ? 'w' : 'FC' });
  const pos = f.positional;
  const first = pos[0];
  // `rest` is the RAW tail after the script/tool name (flags included, e.g. --help / --listTests), not just positionals
  const at = first === undefined ? -1 : args.indexOf(first);
  const tailAfter = (name, from) => {
    const i = name === undefined ? -1 : args.indexOf(name, from);
    return i < 0 ? [] : args.slice(i + 1);
  };
  if (['run', 'run-script'].includes(first)) return { kind: 'run', target: pos[1], rest: tailAfter(pos[1], at + 1), flags: f };
  if (['exec', 'dlx', 'x'].includes(first))
    return { kind: first === 'exec' ? 'exec' : 'dlx', target: pos[1], rest: pos[1] === undefined ? [] : args.slice(args.indexOf(pos[1], at + 1)), flags: f };
  return { kind: 'direct', target: first, rest: at < 0 ? [] : args.slice(at + 1), flags: f };
}

// ---- verification command classification (used by post-bash) --------------------------------------------------------

const VERIFY_SCRIPTS = new Set([
  'test',
  'lint',
  'typecheck',
  'format:check',
  'build',
  'specs:check',
  'deps:check',
  'smoke',
  'checkpoint:finalize',
  'data-model:check',
  'project-state:check',
  'skills:check',
  'openapi:lint',
  'asyncapi:validate',
  'identity:check',
]);
export const isTestClass = (c) => c === 'test' || c.startsWith('test:') || c === 'vitest';

/** Returns a verification class ("test", "lint", "typecheck", "test:integration", "vitest", ...) for a segment, or null. */
export function verificationClass(seg) {
  const info = commandInfo(seg);
  if (!info.cmd) return null;
  if (['pnpm', 'npm', 'yarn'].includes(info.cmd)) {
    const t = pkgScript(info.cmd, info.args);
    if (t.kind === 'exec' || t.kind === 'dlx') return toolClass(t.target, t.rest);
    const script = t.target;
    if (!script) return null;
    if (VERIFY_SCRIPTS.has(script) || /^test:/.test(script)) return script;
    if (t.kind === 'direct') return toolClass(script, t.rest);
    return null;
  }
  return toolClass(info.cmd, info.args);
}

function toolClass(cmd, args) {
  if (!cmd) return null;
  const name = base(cmd);
  if (name === 'vitest') return 'vitest';
  if (name === 'tsc') return args.includes('--noEmit') || args.includes('-b') || args.includes('--build') || args.includes('-p') ? 'typecheck' : null;
  if (name === 'eslint') return 'lint';
  if (name === 'prettier') return args.includes('--check') || args.includes('-c') ? 'format:check' : null;
  if (name === 'turbo') {
    const task = args.find((a) => !a.startsWith('-') && a !== 'run');
    return task && (VERIFY_SCRIPTS.has(task) || /^test:/.test(task)) ? task : null;
  }
  return null;
}
