// Removes comments (and the blank lines they leave) from v0.5.html's inline
// <script> and <style> blocks at deploy time. The page is ~20 % comments;
// they are what makes a 15 000-line single file maintainable, but every
// passenger was downloading them on every open (~70 KB compressed).
//
// The file in the repo is never changed — this runs as part of wrangler's
// [build] command (see wrangler.toml), on the deploy checkout only, and
// only in CI.
//
// Safety:
//   - Code is tokenised (strings, template literals, regex literals), never
//     pattern-matched, and nothing but comments and blank lines is removed.
//   - Each stripped script must still compile, or the page is left untouched.
//   - tests/strip.test.mjs proves, on every PR, that the stripped page has
//     exactly the same JS tokens and CSS rules as the source, and boots.
//   - Like stamp-build.mjs, it never fails a deploy: any problem is logged
//     and the unstripped page ships.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// A `/` after one of these words starts a regex, not a division.
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new',
  'else', 'do', 'instanceof', 'yield', 'await']);
const isWordChar = (c) => /[A-Za-z0-9_$ -￿]/.test(c);

// Output buffer that keeps the current line separate, so "is this line blank
// so far?" and "drop this line's indent" are cheap on a 600 KB script.
function lineBuffer() {
  const done = [];
  let line = '';
  return {
    emit(str) {
      const k = str.lastIndexOf('\n');
      if (k === -1) { line += str; return; }
      done.push(line + str.slice(0, k + 1));
      line = str.slice(k + 1);
    },
    lineIsBlank: () => line.trim() === '',
    dropLine() { line = ''; },
    trimLineEnd() { line = line.replace(/[ \t]+$/, ''); },
    lineTail: (len) => line.slice(-len),
    toString: () => done.join('') + line,
  };
}

export function stripJs(src) {
  const n = src.length;
  const out = lineBuffer();
  let i = 0;
  let prevIsValue = false;      // was the last token something a `/` would divide?
  const templates = [];         // one brace-depth counter per open `${ … }`

  function copyString(quote) {
    const start = i++;
    while (i < n && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
    i++;
    out.emit(src.slice(start, i));
  }
  // Copies template text up to the closing backtick or the next `${`.
  function copyTemplateText() {
    const start = i;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; break; }
      if (c === '$' && src[i + 1] === '{') { i += 2; templates.push(0); break; }
      i++;
    }
    out.emit(src.slice(start, i));
  }
  function copyRegex() {
    const start = i++;
    let inClass = false;
    let closed = false;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') break;                        // not a regex after all — bail out safely
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { i++; closed = true; break; }
      i++;
    }
    if (closed) while (i < n && /[a-z]/i.test(src[i])) i++;
    out.emit(src.slice(start, i));
  }

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (c === '/' && d === '/') {                   // line comment
      while (i < n && src[i] !== '\n') i++;
      if (out.lineIsBlank()) { out.dropLine(); if (src[i] === '\n') i++; }
      else out.trimLineEnd();
      continue;
    }
    if (c === '/' && d === '*') {                   // block comment
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      const multiline = src.slice(i, stop).includes('\n');
      i = stop;
      if (out.lineIsBlank() && /^[ \t]*(\n|$)/.test(src.slice(i, i + 200))) {
        out.dropLine();                             // comment had the line(s) to itself
        while (i < n && src[i] !== '\n') i++;
        if (src[i] === '\n') i++;
      } else {
        out.emit(multiline ? '\n' : ' ');           // keep tokens (and ASI) apart
      }
      continue;
    }
    if (c === '\n') {                               // collapse blank lines (code only)
      if (out.lineIsBlank()) out.dropLine(); else out.emit(c);
      i++; continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { out.emit(c); i++; continue; }
    if (c === '"' || c === "'") { copyString(c); prevIsValue = true; continue; }
    if (c === '`') { out.emit(c); i++; copyTemplateText(); prevIsValue = true; continue; }
    if (c === '/') {
      if (prevIsValue) { out.emit(c); i++; prevIsValue = false; } else { copyRegex(); prevIsValue = true; }
      continue;
    }
    if (isWordChar(c)) {
      let j = i;
      while (j < n && isWordChar(src[j])) j++;
      const word = src.slice(i, j);
      // `x.return`, `obj.in` etc. are property names, i.e. values.
      const tail = out.lineTail(5);
      const afterDot = /\.\s*$/.test(tail) && !/\.\.\.\s*$/.test(tail);
      prevIsValue = afterDot || !REGEX_AFTER_WORD.has(word);
      out.emit(word); i = j; continue;
    }
    if (templates.length) {
      if (c === '{') templates[templates.length - 1]++;
      else if (c === '}') {
        if (templates[templates.length - 1] === 0) {  // end of `${ … }` → back to template text
          templates.pop(); out.emit(c); i++; copyTemplateText(); prevIsValue = true; continue;
        }
        templates[templates.length - 1]--;
      }
    }
    if ((c === '+' || c === '-') && d === c && prevIsValue) { out.emit(c + d); i += 2; continue; }  // x++ / y
    prevIsValue = c === ')' || c === ']';
    out.emit(c); i++;
  }
  return out.toString();
}

export function stripCss(src) {
  const n = src.length;
  const out = lineBuffer();
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      if (/^[ \t]*(\n|$)/.test(src.slice(i, i + 200))) out.trimLineEnd();   // comment ended the line
      else if (!out.lineIsBlank()) out.emit(' ');
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i++;
      while (i < n && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i++;
      out.emit(src.slice(start, i));
      continue;
    }
    if (c === '\n') {
      if (out.lineIsBlank()) out.dropLine(); else out.emit(c);
      i++; continue;
    }
    out.emit(c); i++;
  }
  return out.toString();
}

const compiles = (code) => { try { new vm.Script(code); return true; } catch { return false; } };

// Returns the page with every inline <script> and <style> stripped.
// Throws if a script no longer compiles after stripping.
//
// Walks the HTML in order instead of pattern-matching it, because the page's
// own HTML comments mention "<script>" and "<style>" in prose: HTML comments
// are skipped whole, and <script src=…> elements are passed through.
export function stripPage(html) {
  const lower = html.toLowerCase();
  let out = '';
  let i = 0;
  const copyTo = (end) => { out += html.slice(i, end); i = end; };
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    copyTo(lt);
    if (lower.startsWith('<!--', i)) {
      const end = lower.indexOf('-->', i + 4);
      copyTo(end === -1 ? html.length : end + 3);
      continue;
    }
    const tag = lower.startsWith('<script', i) ? 'script' : lower.startsWith('<style', i) ? 'style' : null;
    const openEnd = tag ? html.indexOf('>', i) : -1;
    const closeAt = tag && openEnd !== -1 ? lower.indexOf(`</${tag}`, openEnd) : -1;
    if (!tag || openEnd === -1 || closeAt === -1 || !/[\s>]/.test(lower[i + 1 + tag.length])) {
      copyTo(i + 1);
      continue;
    }
    const bare = openEnd === i + tag.length + 1;      // exactly <script> / <style>, no attributes
    const body = html.slice(openEnd + 1, closeAt);
    copyTo(openEnd + 1);
    if (!bare) { copyTo(closeAt); continue; }
    if (tag === 'style') { out += stripCss(body); i = closeAt; continue; }
    const stripped = stripJs(body);
    if (!compiles(stripped)) throw new Error('a stripped <script> no longer compiles');
    out += stripped; i = closeAt;
  }
  return out + html.slice(i);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const env = process.env;
    if (!env.CI && !env.WORKERS_CI && !env.FN_STRIP) {
      console.log('[strip-comments] not in CI — leaving v0.5.html as it is');
    } else {
      const file = new URL('../v0.5.html', import.meta.url);
      const html = readFileSync(file, 'utf8');
      const stripped = stripPage(html);
      writeFileSync(file, stripped);
      console.log(`[strip-comments] v0.5.html ${html.length} → ${stripped.length} bytes`);
    }
  } catch (err) {
    console.warn('[strip-comments] skipped, shipping the page unstripped:', err && err.message);
  }
}
