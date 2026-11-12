// Every way the app can start: each must end on the right screen, with the
// static boot splash gone and no uncaught errors.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launch, mockBackend, newAppPage, SESSION_ID } from './helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser.close(); await server.close(); });

async function boot(url, opts = {}) {
  const { page, errors } = await newAppPage(browser, opts);
  if (opts.noMapboxLib) await page.route(/vendor\/mapbox-gl.*\.js/, (r) => r.abort());
  const calls = await mockBackend(page, opts);
  await page.goto(server.base + url);
  await page.waitForTimeout(2500);
  const state = await page.evaluate(() => ({
    splash: !!document.getElementById('boot-splash'),
    loading: !!document.getElementById('loading-screen'),
    bootError: !!document.getElementById('fn-boot-error'),
    bootOk: window.__fnBootOk,
    text: document.body.innerText,
  }));
  await page.close();
  return { state, calls, errors };
}
const names = (calls, via) => calls.filter((c) => c.via === via).map((c) => c.name);

test('session link: early reads are used, no duplicate queries', async () => {
  const { state, calls, errors } = await boot(`/v0.5?session=${SESSION_ID}`);
  assert.deepEqual(errors, []);
  assert.equal(state.bootOk, true);
  assert.equal(state.splash, false);
  assert.equal(state.loading, false);
  assert.match(state.text, /your name/i);                       // reached the name gate
  assert.deepEqual(names(calls, 'pre').sort(), ['sessions', 'stop_activations', 'tours']);
  for (const n of ['sessions', 'tours', 'stop_activations']) {
    assert.ok(!names(calls, 'lib').includes(n), `${n} was fetched twice`);
  }
});

test('/j/<id> short link behaves like ?session=', async () => {
  const { state, calls, errors } = await boot(`/j/${SESSION_ID}`);
  assert.deepEqual(errors, []);
  assert.match(state.text, /your name/i);
  assert.ok(names(calls, 'pre').includes('tours'));
});

test('early reads failing falls back to the normal queries', async () => {
  const { state, calls, errors } = await boot(`/v0.5?session=${SESSION_ID}`, { preFail: true });
  assert.deepEqual(errors, []);
  assert.match(state.text, /your name/i);
  for (const n of ['sessions', 'tours', 'stop_activations']) {
    assert.ok(names(calls, 'lib').includes(n), `${n} was not re-fetched by the app`);
  }
});

test('bare URL shows the landing screen', async () => {
  const { state, calls, errors } = await boot('/v0.5');
  assert.deepEqual(errors, []);
  assert.equal(state.bootOk, true);
  assert.equal(state.splash, false);
  assert.equal(calls.length, 0);
});

test('first-time passenger gets the language gate', async () => {
  const { state, errors } = await boot(`/v0.5?session=${SESSION_ID}`, { lang: false });
  assert.deepEqual(errors, []);
  assert.equal(state.splash, false);
  assert.match(state.text, /choose your language/i);
});

test('unknown session lands on the join screen, not an error', async () => {
  const { state, errors } = await boot('/v0.5?session=zzz', { session: null });
  assert.deepEqual(errors, []);
  assert.equal(state.splash, false);
  assert.equal(state.bootError, false);
  assert.equal(state.loading, false);
});

test('backend unreachable: no crash, no boot-error overlay', async () => {
  const { state, errors } = await boot(`/v0.5?session=${SESSION_ID}`, { offline: true });
  assert.deepEqual(errors, []);
  assert.equal(state.bootOk, true);
  assert.equal(state.bootError, false);
  assert.equal(state.splash, false);
});

test('a missing library shows the retry screen', async () => {
  const { state } = await boot(`/v0.5?session=${SESSION_ID}`, { noMapboxLib: true });
  assert.equal(state.bootError, true);
  assert.equal(state.splash, false);
  assert.match(state.text, /try again/i);
});
