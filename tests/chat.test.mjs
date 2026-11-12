// Tour chat "pokes": an empty realtime broadcast after each post makes open
// chats refresh at once; polling is the backstop. The realtime channel is
// replaced by an in-page stand-in so both the live and the down case run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launch, mockBackend, newAppPage, SESSION_ID } from './helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser.close(); await server.close(); });

const TOPIC = `chat-poke:${SESSION_ID}`;

async function openChat(live) {
  const { page, errors } = await newAppPage(browser);
  const msgs = [{ id: 1, sender_role: 'guide', sender_name: 'G', body: 'hi', created_at: new Date().toISOString(), thread_passenger_id: null }];
  const calls = await mockBackend(page, {
    handlers: {
      session_passengers: (req) => ((req.headers().accept || '').includes('pgrst.object') ? { name: 'Ann' } : [{ name: 'Ann' }]),
      claim_session_chat_key: () => true,
      session_chat_latest: () => ({ group_id: msgs.length, private_id: 0, ended: false }),
      list_session_chat: (req) => {
        let after = 0;
        try { after = JSON.parse(req.postData()).p_after_id || 0; } catch { /* no body */ }
        return msgs.filter((m) => m.id > after);
      },
      post_session_chat: () => {
        msgs.push({ id: msgs.length + 1, sender_role: 'passenger', sender_name: 'Ann', body: 'yo', created_at: new Date().toISOString(), thread_passenger_id: null });
        return { ok: true, id: msgs.length };
      },
    },
  });
  await page.goto(`${server.base}/v0.5?session=${SESSION_ID}`);
  await page.waitForTimeout(2500);
  await page.evaluate((isLive) => {
    window.__sent = 0; window.__bus = {};
    const real = supabaseClient.channel.bind(supabaseClient);
    supabaseClient.channel = (topic, o) => {
      if (!topic.startsWith('chat-poke:')) return real(topic, o);
      const ch = {
        on(_type, _filter, cb) { (window.__bus[topic] = window.__bus[topic] || []).push(cb); return ch; },
        subscribe(cb) { setTimeout(() => cb(isLive ? 'SUBSCRIBED' : 'CHANNEL_ERROR'), 10); return ch; },
        send() { window.__sent++; return Promise.resolve('ok'); },
      };
      return ch;
    };
    supabaseClient.removeChannel = () => {};
    startTourChatBadge();
    openTourChat();
  }, live);
  await page.waitForTimeout(1500);
  const shown = () => page.evaluate(() => document.querySelectorAll('#sc-list > *').length);
  const polls = () => calls.filter((c) => c.name === 'list_session_chat').length;
  return { page, errors, msgs, shown, polls };
}

test('pokes live: no polling, a poke shows the message, sending pokes others', async () => {
  const { page, errors, msgs, shown, polls } = await openChat(true);
  assert.equal(await shown(), 1);
  const before = polls();
  await page.waitForTimeout(13000);
  assert.equal(polls() - before, 0, 'polled although pokes are live');

  msgs.push({ id: 2, sender_role: 'guide', sender_name: 'G', body: 'new', created_at: new Date().toISOString(), thread_passenger_id: null });
  await page.evaluate((t) => window.__bus[t].forEach((cb) => cb({})), TOPIC);
  await page.waitForTimeout(900);
  assert.equal(await shown(), 2, 'poke did not refresh the open chat');

  await page.fill('#sc-input', 'yo');
  await page.click('#sc-send');
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => window.__sent), 1, 'no poke sent after posting');

  // Closing the chat keeps the channel for the unread badge, and only that.
  await page.evaluate(() => closeTourChat());
  assert.equal(await page.evaluate((t) => _chatPokes[t] && _chatPokes[t].subs.size, TOPIC), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test('pokes down: falls back to polling at the old pace and sends nothing', async () => {
  const { page, errors, polls } = await openChat(false);
  const before = polls();
  await page.waitForTimeout(13000);
  assert.ok(polls() - before >= 2, 'did not fall back to polling');
  await page.fill('#sc-input', 'yo');
  await page.click('#sc-send');
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => window.__sent), 0);
  assert.deepEqual(errors, []);
  await page.close();
});
