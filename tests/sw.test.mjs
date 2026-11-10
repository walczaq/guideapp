// The real service worker, with mocked map-tile responses.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launch } from './helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser.close(); await server.close(); });

test('shell precache and map-tile caching', async () => {
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const hits = {};
  let n = 0;
  await context.route(/api\.mapbox\.com/, (route) => {
    const url = route.request().url();
    hits[url] = (hits[url] || 0) + 1;
    route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/x-protobuf', 'cache-control': 'max-age=43200' },
      body: `TILE${++n}`,
    });
  });
  await context.route(/supabase\.co|fonts\.g/, (route) => route.abort());
  const page = await context.newPage();
  await page.goto(`${server.base}/v0.5`);
  await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js', { scope: '/' }); await navigator.serviceWorker.ready; });
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForTimeout(1500);

  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const text = async (u) => (await fetch(u)).text();
    const out = { controlled: !!navigator.serviceWorker.controller };
    const shellName = (await caches.keys()).find((k) => k.includes('shell'));
    const shell = await caches.open(shellName);
    out.shell = (await shell.keys()).map((k) => new URL(k.url).pathname);

    const fresh = 'https://api.mapbox.com/v4/mapbox.streets/1/2/3.vector.pbf?access_token=x';
    out.fresh = [await text(fresh)]; await wait(400);
    out.fresh.push(await text(fresh)); await wait(400);
    out.fresh.push(await text(fresh));
    const tiles = await caches.open('fieldnote-tiles-v1');
    const hit = await tiles.match(fresh);
    out.stamp = hit.headers.get('x-fn-cached-at');
    out.contentType = hit.headers.get('content-type');

    // An entry cached before stamps existed: served, then refreshed + stamped.
    const legacy = 'https://api.mapbox.com/v4/mapbox.streets/9/9/9.vector.pbf?access_token=x';
    await tiles.put(legacy, new Response('OLD'));
    out.legacyFirst = await text(legacy); await wait(500);
    out.legacySecond = await text(legacy);
    out.legacyStamped = !!(await tiles.match(legacy)).headers.get('x-fn-cached-at');

    // An entry older than the freshness window: served stale, then refreshed.
    const stale = 'https://api.mapbox.com/v4/mapbox.streets/8/8/8.vector.pbf?access_token=x';
    await tiles.put(stale, new Response('STALE', { headers: { 'x-fn-cached-at': String(Date.now() - 25 * 3600 * 1000) } }));
    out.staleFirst = await text(stale); await wait(500);
    out.staleSecond = await text(stale);
    out.freshUrl = fresh;
    return out;
  });

  assert.equal(r.controlled, true);
  const html = await page.content();
  for (const src of html.match(/\/vendor\/[\w.-]+\.(?:js|css)/g)) {
    assert.ok(r.shell.includes(src), `${src} is used by the page but not precached by sw.js`);
  }
  assert.deepEqual(r.fresh, ['TILE1', 'TILE1', 'TILE1']);
  assert.equal(hits[r.freshUrl], 1, 'a fresh tile was re-downloaded');
  assert.ok(Number(r.stamp) > 0);
  assert.equal(r.contentType, 'application/x-protobuf');
  assert.equal(r.legacyFirst, 'OLD');
  assert.match(r.legacySecond, /^TILE/);
  assert.equal(r.legacyStamped, true);
  assert.equal(r.staleFirst, 'STALE');
  assert.match(r.staleSecond, /^TILE/);
  await context.close();
});
