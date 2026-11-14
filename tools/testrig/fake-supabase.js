// Offline test rig: served in place of /vendor/supabase-js-*.umd.js.
// Provides window.supabase.createClient() with the slice of the supabase-js
// API the app uses, backed by the rig's in-memory backend in Node
// (window.__rig is a Playwright binding; window.__rigEvent receives realtime).
// Set window.__rigOffline = true to make every call fail like a dead network.
(function () {
  const clientId = Math.random().toString(36).slice(2);
  const down = () => ({ data: null, error: { message: 'TypeError: Failed to fetch (rig offline)', code: '' } });
  const call = (kind, body) => window.__rigOffline
    ? Promise.resolve(down())
    : window.__rig({ kind, body, clientId });

  class Query {
    constructor(table) { this.q = { table, op: 'select', filters: [], order: [], limit: null, single: null, returning: false }; }
    select() { if (this.q.op !== 'select') this.q.returning = true; return this; }
    insert(values) { this.q.op = 'insert'; this.q.values = values; return this; }
    update(values) { this.q.op = 'update'; this.q.values = values; return this; }
    delete() { this.q.op = 'delete'; return this; }
    order(col, o) { this.q.order.push({ col, asc: !(o && o.ascending === false) }); return this; }
    limit(n) { this.q.limit = n; return this; }
    single() { this.q.single = 'single'; return this; }
    maybeSingle() { this.q.single = 'maybe'; return this; }
    abortSignal() { return this; }
    then(res, rej) { return call('query', this.q).then(res, rej); }
    catch(rej) { return this.then(undefined, rej); }
  }
  for (const type of ['eq', 'neq', 'is', 'ilike', 'gte', 'gt', 'lte', 'lt', 'in']) {
    Query.prototype[type] = function (col, val) { this.q.filters.push({ type, col, val }); return this; };
  }

  const channels = new Set();
  class Channel {
    constructor(topic) { this.topic = topic; this.handlers = []; }
    on(type, filter, cb) { this.handlers.push({ type, filter: filter || {}, cb }); return this; }
    subscribe(cb) { channels.add(this); setTimeout(() => { try { cb && cb('SUBSCRIBED'); } catch (_e) {} }, 0); return this; }
    unsubscribe() { channels.delete(this); return Promise.resolve('ok'); }
    send(msg) { return call('broadcast', { topic: this.topic, event: msg.event, payload: msg.payload }).then(() => 'ok'); }
  }
  const rowMatches = (filter, row) => {
    if (!filter) return true;
    const m = /^([a-z_]+)=eq\.(.*)$/.exec(filter);
    return !m || String(row[m[1]]) === m[2];
  };
  window.__rigEvent = function (ev) {
    if (window.__rigOffline) return;
    for (const ch of Array.from(channels)) {
      for (const h of ch.handlers) {
        try {
          if (ev.kind === 'pg' && h.type === 'postgres_changes') {
            if (h.filter.table !== ev.table) continue;
            if (h.filter.event !== '*' && h.filter.event !== ev.eventType) continue;
            if (!rowMatches(h.filter.filter, ev.eventType === 'DELETE' ? ev.old : ev.new)) continue;
            h.cb({ eventType: ev.eventType, new: ev.new, old: ev.old, schema: 'public', table: ev.table, commit_timestamp: ev.commit_timestamp });
          } else if (ev.kind === 'broadcast' && h.type === 'broadcast') {
            if (ev.topic !== ch.topic || ev.from === clientId) continue;
            if (h.filter.event && h.filter.event !== ev.event) continue;
            h.cb({ type: 'broadcast', event: ev.event, payload: ev.payload });
          }
        } catch (e) { console.warn('[rig] realtime handler threw', e); }
      }
    }
  };

  const client = {
    from: (table) => new Query(table),
    rpc: (fn, args) => call('rpc', { fn, args: args || {} }),
    channel: (topic) => new Channel(topic),
    removeChannel: (ch) => { channels.delete(ch); return Promise.resolve('ok'); },
    storage: { from: () => ({ uploadToSignedUrl: async () => ({ data: null, error: { message: 'rig: uploads are not available offline' } }) }) },
    realtime: { setAuth() {} },
  };
  window.supabase = { createClient: () => client };
})();
