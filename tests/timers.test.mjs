// Background-request cadences. These are the "quiet when healthy, fast when
// something needs healing" rules; each test counts real requests over a
// window. Realtime can't connect under the mock, so "healthy" is forced by
// pinning the channel-status variables.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launch, mockBackend, newAppPage, makeSession, SESSION_ID } from './helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser.close(); await server.close(); });

const count = (calls, name) => calls.filter((c) => c.name === name).length;

async function open(opts = {}) {
  const { page, errors } = await newAppPage(browser, opts);
  const calls = await mockBackend(page, {
    ...opts,
    handlers: {
      lookup_guide_by_token: () => [{ guide_id: 'g1', guide_name: 'G' }],
      session_passengers: (req) => ((req.headers().accept || '').includes('pgrst.object')
        ? { name: 'Ann' }
        : [{ passenger_id: 'p1', name: 'Ann', in_bus: false, last_seen: new Date().toISOString() }]),
    },
  });
  await page.goto(`${server.base}/v0.5?session=${SESSION_ID}`);
  await page.waitForTimeout(3000);
  return { page, calls, errors };
}

describe('About-screen debug lines', () => {
  test('tick only while the About screen is open', async () => {
    const { page, errors } = await open();
    const writes = (ms) => page.evaluate(async (wait) => {
      let n = 0;
      const mo = new MutationObserver(() => n++);
      mo.observe(document.getElementById('debug-sync-stats'), { childList: true, characterData: true, subtree: true });
      await new Promise((r) => setTimeout(r, wait));
      mo.disconnect();
      return n;
    }, ms);
    assert.equal(await writes(4500), 0, 'ticking while closed');
    await page.evaluate(() => openScreen('screen-about'));
    assert.ok(await writes(4500) >= 2, 'not ticking while open');
    await page.evaluate(() => closeScreen());
    await page.waitForTimeout(2200);
    assert.equal(await writes(4500), 0, 'still ticking after close');
    assert.deepEqual(errors, []);
    await page.close();
  });
});

describe('guide passenger re-pull', { concurrency: true }, () => {
  const WINDOW = 40000;
  async function repulls(session, setup) {
    const { page, calls, errors } = await open({ guide: true, session });
    assert.equal(await page.evaluate(() => ROLE), 'guide');
    await page.evaluate(setup);
    const start = count(calls, 'session_passengers');
    await page.waitForTimeout(WINDOW);
    const n = count(calls, 'session_passengers') - start;
    assert.deepEqual(errors, []);
    await page.close();
    return n;
  }
  const healthy = () => { setInterval(() => { _namesChannelStatus = 'SUBSCRIBED'; }, 50); };

  test('every 5 s while the realtime channel is down', async () => {
    assert.ok(await repulls(makeSession(), () => {}) >= 6);
  });
  test('every 5 s during boarding', async () => {
    assert.ok(await repulls(makeSession({ tour_started_at: null }), healthy) >= 6);
  });
  test('backs off to 30 s once the tour is running and healthy', async () => {
    const n = await repulls(makeSession(), healthy);
    assert.ok(n >= 1 && n <= 3, `expected 1-3 re-pulls in 40 s, got ${n}`);
  });
  test('every 5 s while a passenger on the map has no name', async () => {
    const n = await repulls(makeSession(), () => {
      setInterval(() => {
        _namesChannelStatus = 'SUBSCRIBED';
        if (!PASSENGERS.has('p9')) PASSENGERS.set('p9', { name: null, lng: -21.9, lat: 64.1, _seenTimestamps: new Set(), trail: [] });
      }, 50);
    });
    assert.ok(n >= 6, `expected >=6 re-pulls in 40 s, got ${n}`);
  });
});

describe('passenger session poll', { concurrency: true }, () => {
  const WINDOW = 50000;
  async function polls(setup) {
    const { page, calls, errors } = await open();
    // Past the name gate the poll is already running; count the app's own
    // session-row reads (the early <head> read is tagged 'pre').
    const libSessions = () => calls.filter((c) => c.name === 'sessions' && c.via === 'lib').length;
    assert.equal(await page.evaluate(() => !!_sessionPollTimer), true, 'poll not started');
    await page.evaluate(setup);
    const start = libSessions();
    await page.waitForTimeout(WINDOW);
    const n = libSessions() - start;
    assert.deepEqual(errors, []);
    await page.close();
    return n;
  }
  test('every 15 s while a realtime channel is down', async () => {
    const n = await polls(() => {});
    assert.ok(n >= 3, `expected >=3 polls in 50 s, got ${n}`);
  });
  test('backs off to 45 s while both channels are subscribed', async () => {
    const n = await polls(() => {
      setInterval(() => { _sessionChannelStatus = 'SUBSCRIBED'; _stopActivationChannelStatus = 'SUBSCRIBED'; }, 50);
    });
    assert.ok(n >= 1 && n <= 2, `expected 1-2 polls in 50 s, got ${n}`);
  });
});
