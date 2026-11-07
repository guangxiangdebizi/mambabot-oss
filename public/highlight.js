// A small syntax highlighter for code in replies and in the reader: one regular expression
// per language family splits the text into comments, strings, numbers, keywords and the like,
// returned as DOM spans (text nodes only). Unknown languages get comments/strings/numbers.

const kw = (words) => String.raw`\b(?:${words.trim().split(/\s+/).join('|')})\b`;
const DQ = String.raw`"(?:[^"\\\n]|\\.)*"`;
const SQ = String.raw`'(?:[^'\\\n]|\\.)*'`;
const BT = String.raw`\`(?:[^\`\\]|\\.)*\``;
const NUM = String.raw`\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]*\b`;
const LIT = kw('true false null undefined None True False nil NaN Infinity');
const FN = String.raw`\b[A-Za-z_$][\w$]*(?=\s*\()`;

const C_KEYWORDS = `
  abstract as async await break case catch class const continue def default defer delete do else enum export extends
  final finally fn for from func function go goto if impl implements import in instanceof interface internal let
  match mod module mut namespace new override package private protected pub public readonly return select static
  struct super switch this throw throws trait try type typeof unsafe use using var void volatile where while with
  yield chan map range fallthrough sealed object val when lateinit suspend inline extern sizeof template typename
  unsigned signed int long short char float double bool boolean byte string str void auto register union echo
`;

const LANGS = {
  clike: [
    ['c', String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`],
    ['s', `${BT}|${DQ}|${SQ}`],
    ['l', LIT],
    ['k', kw(C_KEYWORDS)],
    ['n', NUM],
    ['f', FN],
  ],
  py: [
    ['s', String.raw`(?:[rRbBuUfF]{0,2})(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|${DQ}|${SQ})`],
    ['c', String.raw`#[^\n]*`],
    ['l', LIT],
    ['k', kw(`and as assert async await break class continue def del elif else except finally for from global if import
      in is lambda nonlocal not or pass raise return try while with yield match case self cls print`)],
    ['m', String.raw`@[\w.]+`],
    ['n', NUM],
    ['f', FN],
  ],
  sh: [
    ['c', String.raw`(?:^|(?<=\s))#[^\n]*`],
    ['s', `${DQ}|${SQ}`],
    ['v', String.raw`\$(?:\{[^}\n]*\}|\w+|[@#?$!*-])`],
    ['k', kw(`if then else elif fi for while until do done case esac in function return local export readonly unset
      shift source alias set exit break continue select sudo cd echo printf read trap eval exec test`)],
    ['p', String.raw`(?<=\s)--?[\w-]+`],
    ['n', String.raw`\b\d+\b`],
  ],
  json: [
    ['p', String.raw`${DQ}(?=\s*:)`],
    ['s', DQ],
    ['l', kw('true false null')],
    ['n', String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b`],
    ['c', String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`],
  ],
  css: [
    ['c', String.raw`\/\*[\s\S]*?(?:\*\/|$)`],
    ['s', `${DQ}|${SQ}`],
    ['p', String.raw`[\w-]+(?=\s*:(?!:))`],
    ['m', String.raw`@[\w-]+|![\w]+`],
    ['n', String.raw`#[\da-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|%|s|ms|deg|fr|ch)?\b`],
  ],
  markup: [
    ['c', String.raw`<!--[\s\S]*?(?:-->|$)`],
    ['t', String.raw`<\/?[\w:-]+|\/?>`],
    ['a', String.raw`\b[\w:-]+(?==)`],
    ['s', `${DQ}|${SQ}`],
  ],
  sql: [
    ['c', String.raw`--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`],
    ['s', `${SQ}|${DQ}`],
    ['k', String.raw`\b(?:select|from|where|and|or|not|insert|into|values|update|set|delete|create|table|drop|alter|add|index|view|join|left|right|inner|outer|full|on|as|group|by|order|having|limit|offset|union|all|distinct|case|when|then|else|end|is|null|in|like|between|exists|primary|key|foreign|references|default|with|returning|asc|desc|count|sum|avg|min|max)\b`],
    ['n', NUM],
  ],
  yaml: [
    ['c', String.raw`(?:^|(?<=\s))#[^\n]*`],
    ['p', String.raw`^[ \t-]*[\w.$/-]+(?=\s*[:=])|^\s*\[[^\]\n]+\]`],
    ['s', `${DQ}|${SQ}`],
    ['l', kw('true false null yes no on off')],
    ['n', String.raw`-?\b\d+(?:\.\d+)?\b`],
  ],
  plain: [
    ['c', String.raw`(?:^|(?<=\s))(?:\/\/|#)[^\n]*`],
    ['s', `${DQ}|${SQ}`],
    ['n', NUM],
  ],
};

const ALIASES = {
  js: 'clike', javascript: 'clike', mjs: 'clike', cjs: 'clike', jsx: 'clike', ts: 'clike', typescript: 'clike', tsx: 'clike',
  java: 'clike', kotlin: 'clike', kt: 'clike', scala: 'clike', swift: 'clike', c: 'clike', h: 'clike', cpp: 'clike', 'c++': 'clike',
  cc: 'clike', hpp: 'clike', cs: 'clike', csharp: 'clike', go: 'clike', golang: 'clike', rust: 'clike', rs: 'clike', php: 'clike',
  dart: 'clike', groovy: 'clike', gradle: 'clike', proto: 'clike', zig: 'clike', solidity: 'clike', sol: 'clike', vue: 'markup',
  py: 'py', python: 'py', python3: 'py', ipython: 'py', pyi: 'py',
  sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', shellsession: 'sh', ps1: 'sh', powershell: 'sh', bat: 'sh', cmd: 'sh', dockerfile: 'sh', docker: 'sh', makefile: 'sh', make: 'sh', mk: 'sh',
  json: 'json', jsonc: 'json', json5: 'json', geojson: 'json', ipynb: 'json',
  css: 'css', scss: 'css', less: 'css', sass: 'css',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', xhtml: 'markup', plist: 'markup',
  sql: 'sql', psql: 'sql', mysql: 'sql', sqlite: 'sql', pgsql: 'sql',
  yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml', conf: 'yaml', cfg: 'yaml', env: 'yaml', properties: 'yaml',
};

const compiled = new Map();
function grammar(lang) {
  const name = ALIASES[String(lang || '').toLowerCase()] || (lang === 'diff' || lang === 'patch' ? 'diff' : null);
  if (!name) return null;
  if (name === 'diff') return 'diff';
  if (!compiled.has(name)) {
    const rules = LANGS[name];
    compiled.set(name, { classes: rules.map((r) => r[0]), re: new RegExp(rules.map((r) => `(${r[1]})`).join('|'), name === 'sql' ? 'gim' : 'gm') });
  }
  return compiled.get(name);
}

/** Language name for a file, from its extension (or name: Makefile, Dockerfile). */
export function langOfFile(name) {
  const base = String(name || '').split('/').pop().toLowerCase();
  if (base === 'makefile' || base === 'dockerfile') return base;
  if (base.startsWith('.env') || base.endsWith('rc')) return 'sh';
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return ALIASES[ext] ? ext : (ext === 'diff' || ext === 'patch' ? 'diff' : '');
}

const MAX = 200 * 1024;

/** Highlighted copy of `code` as a fragment, or null when there is nothing to do. */
export function highlight(doc, code, lang) {
  const text = String(code ?? '');
  const g = grammar(lang);
  if (!g || !text || text.length > MAX) return null;
  const frag = doc.createDocumentFragment();
  const span = (cls, t) => {
    const s = doc.createElement('span');
    s.className = `hl-${cls}`;
    s.textContent = t;
    return s;
  };
  if (g === 'diff') {
    text.split('\n').forEach((line, i) => {
      if (i) frag.append(doc.createTextNode('\n'));
      const cls = /^(\+\+\+|---)/.test(line) ? 'meta' : line.startsWith('+') ? 'ins' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'meta' : null;
      frag.append(cls ? span(cls, line) : doc.createTextNode(line));
    });
    return frag;
  }
  let last = 0;
  g.re.lastIndex = 0;
  for (const m of text.matchAll(g.re)) {
    if (!m[0]) continue;
    if (m.index > last) frag.append(doc.createTextNode(text.slice(last, m.index)));
    const i = m.slice(1).findIndex((x) => x !== undefined);
    frag.append(span(g.classes[i], m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(doc.createTextNode(text.slice(last)));
  return frag;
}
