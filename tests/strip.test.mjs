// tools/strip-comments.mjs removes comments from the deployed page. These
// tests are what makes that safe: the stripped page must have exactly the
// same JavaScript tokens and CSS rules as the source, and must boot.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import { stripPage, stripJs, stripCss } from '../tools/strip-comments.mjs';
import { ROOT, startServer, launch, mockBackend, newAppPage, SESSION_ID } from './helpers.mjs';

const html = fs.readFileSync(path.join(ROOT, 'v0.5.html'), 'utf8');
const stripped = stripPage(html);
// Inline <script>/<style> bodies, ignoring HTML comments (which mention both
// tags in prose) and <script src=…> elements.
const blocks = (page, tag) => [...page.replace(/<!--[\s\S]*?-->/g, '')
  .matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);

function tokens(code) {
  const comments = [];
  const list = [];
  for (const t of acorn.tokenizer(code, { ecmaVersion: 'latest', onComment: comments })) {
    const v = t.value;
    list.push(`${t.type.label}:${v && v.pattern !== undefined ? `/${v.pattern}/${v.flags}` : String(v)}`);
  }
  return { list, comments: comments.length };
}

test('stripped scripts have identical tokens and no comments left', () => {
  const before = blocks(html, 'script');
  const afterStrip = blocks(stripped, 'script');
  assert.equal(afterStrip.length, before.length);
  assert.ok(before.length >= 3, 'expected the head, app and fallback scripts');
  let removed = 0;
  before.forEach((code, i) => {
    const a = tokens(code);
    const b = tokens(afterStrip[i]);
    assert.equal(b.comments, 0, `script ${i} still has comments`);
    assert.equal(b.list.length, a.list.length, `script ${i}: token count changed`);
    for (let k = 0; k < a.list.length; k++) {
      if (a.list[k] !== b.list[k]) assert.fail(`script ${i}: token ${k} changed: ${a.list[k]} → ${b.list[k]}`);
    }
    removed += a.comments;
  });
  assert.ok(removed > 1000, 'expected to remove the page\'s comments');
});

test('the page gets meaningfully smaller and nothing outside script/style changes', () => {
  assert.ok(stripped.length < html.length * 0.85, `only ${html.length} → ${stripped.length}`);
  // Everything that is not an inline script/style body must be byte-identical,
  // HTML comments included.
  const skeleton = (p) => {
    const kept = [];
    const masked = p.replace(/<!--[\s\S]*?-->/g, (c) => `\u0000${kept.push(c) - 1}\u0000`);
    return masked.replace(/<script>[\s\S]*?<\/script>/g, '<script></script>')
      .replace(/<style>[\s\S]*?<\/style>/g, '<style></style>')
      .replace(/\u0000(\d+)\u0000/g, (_m, k) => kept[k]);
  };
  assert.equal(skeleton(stripped), skeleton(html));
});

test('tricky JavaScript survives', () => {
  const cases = [
    'const u = "http://x.y/z"; // gone',
    'const r = /\\/\\/[^/]*\\/*/g; /* gone */ const s = a / b / c;',
    'const t = `a // not a comment ${ x /* gone */ + `n ${ {a:1}.a } /* kept */` } /* kept */`;',
    'x = a++ / 2; y = b-- / 2; z = (a) / 2 / 3; w = arr[0] / 2;',
    'if (ok) /re/.test(s); return /[/]\\//.test(s) ? 1 : 2',
    'a = b\n/* multi\nline */\n(c)',
    "const q = 'it\\'s // fine'; const o = { in: 1 }; v = o.in / 2;",
  ];
  for (const code of cases) {
    const out = stripJs(code);
    const lex = (c) => [...acorn.tokenizer(c, { ecmaVersion: 'latest', allowReturnOutsideFunction: true })]
      .map((t) => `${t.type.label}:${t.value && t.value.pattern !== undefined ? t.value.pattern : t.value}`);
    assert.deepEqual(lex(out), lex(code), code);
  }
  assert.equal(stripCss('a{b:"/* x */"} /* gone */\n\n.c{d:url(//e)}'), 'a{b:"/* x */"}\n.c{d:url(//e)}');
});

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser.close(); await server.close(); });

test('stripped styles produce the same CSS rules', async () => {
  const page = await browser.newPage();
  const rules = (css) => page.evaluate((text) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    return [...sheet.cssRules].map((r) => r.cssText);
  }, css);
  const before = blocks(html, 'style');
  const afterStrip = blocks(stripped, 'style');
  assert.equal(afterStrip.length, before.length);
  let total = 0;
  for (let i = 0; i < before.length; i++) {
    const a = await rules(before[i]);
    total += a.length;
    assert.deepEqual(await rules(afterStrip[i]), a);
  }
  assert.ok(total > 100, `expected the app stylesheet, saw ${total} rules`);
  await page.close();
});

test('the stripped page boots to the same screen', async () => {
  const { page, errors } = await newAppPage(browser);
  await mockBackend(page);
  await page.route(/\/v0\.5(\?|$)/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: stripped }));
  await page.goto(`${server.base}/v0.5?session=${SESSION_ID}`);
  await page.waitForTimeout(2500);
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.__fnBootOk), true);
  assert.equal(await page.evaluate(() => !!document.getElementById('boot-splash')), false);
  assert.match(await page.evaluate(() => document.body.innerText), /your name/i);
  await page.close();
});
