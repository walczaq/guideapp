// In-memory stand-in for the Fieldnote Supabase project, used only by the
// offline test rig. It imitates the tables the app reads/writes directly, the
// server functions (RPCs) the app calls, and realtime change events.
//
// It is NOT the real backend: no row-level security, no push, no SMS, no real
// tracker feed. Functions the rig has not implemented answer with an error and
// are recorded in `backend.missing` so a test can see what it leaned on.
const crypto = require('crypto');

const TABLES = ['guides', 'tours', 'stops', 'pins', 'sessions', 'stop_activations', 'passenger_locations',
  'session_passengers', 'guide_locations', 'spot_arrivals', 'session_chat', 'guide_chat', 'companies',
  'company_members', 'buses', 'session_contacts', 'push_subscriptions'];
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const err = (message, code) => ({ data: null, error: { message, code: code || 'RIG' } });
const ok = (data) => ({ data: data === undefined ? null : data, error: null });

class Backend {
  constructor() {
    this.t = {}; for (const n of TABLES) this.t[n] = [];
    this.seq = 1;
    this.listeners = new Set();   // fn(event) — every page bridge registers one
    this.missing = new Set();     // RPC names called but not implemented
    this.log = [];                // [{ kind, name }] — every call, for debugging
  }
  nextId() { return this.seq++; }

  // ── realtime ──
  emit(table, eventType, newRow, oldRow) {
    const ev = { kind: 'pg', table, eventType, new: newRow || {}, old: oldRow || {}, schema: 'public', commit_timestamp: now() };
    for (const fn of this.listeners) { try { fn(ev); } catch (_e) {} }
  }
  broadcast(topic, event, payload, from) {
    const ev = { kind: 'broadcast', topic, event, payload: payload || {}, from };
    for (const fn of this.listeners) { try { fn(ev); } catch (_e) {} }
  }

  // ── table access (what supabase-js .from() does) ──
  insertRow(table, row) {
    const r = Object.assign({}, row);
    const defaults = {
      sessions: () => ({ started_at: now(), ended_at: null, chat_url: null, next_stop_id: null, tour_started_at: null, home_lng: null, home_lat: null, bus_id: null }),
      passenger_locations: () => ({ id: this.nextId(), server_received_at: now() }),
      guide_locations: () => ({ id: this.nextId(), set_at: now(), is_off: false }),
      session_passengers: () => ({ id: this.nextId(), in_bus: false, last_seen: now(), joined_at: now() }),
      spot_arrivals: () => ({ id: this.nextId(), arrived_at: now() }),
      stop_activations: () => ({ id: this.nextId(), activated_at: now(), duration_minutes: 20, notes: null, warning_level: 'none', notes_i18n: null }),
    }[table];
    const row2 = Object.assign(defaults ? defaults() : {}, r);
    this.t[table].push(row2);
    this.emit(table, 'INSERT', row2, null);
    return row2;
  }
  updateRow(table, row, patch) {
    const old = Object.assign({}, row);
    Object.assign(row, patch);
    this.emit(table, 'UPDATE', row, old);
    return row;
  }
  deleteRows(table, pred) {
    const gone = this.t[table].filter(pred);
    this.t[table] = this.t[table].filter(r => !pred(r));
    for (const r of gone) this.emit(table, 'DELETE', null, r);
    return gone;
  }
  tourWithStops(tour) {
    const stops = this.t.stops.filter(s => s.tour_id === tour.id).sort((a, b) => a.ordinal - b.ordinal)
      .map(s => Object.assign({}, s, { pins: this.t.pins.filter(p => p.stop_id === s.id).sort((a, b) => a.ordinal - b.ordinal).map(p => Object.assign({}, p)) }));
    return Object.assign({}, tour, { stops });
  }

  query(q) {
    this.log.push({ kind: q.op, name: q.table });
    const rows = this.t[q.table];
    if (!rows) return err(`relation "${q.table}" does not exist (rig)`, '42P01');
    const match = (r) => (q.filters || []).every(f => {
      const v = r[f.col];
      switch (f.type) {
        case 'eq': return String(v) === String(f.val);
        case 'neq': return String(v) !== String(f.val);
        case 'is': return f.val === null ? (v === null || v === undefined) : v === f.val;
        case 'ilike': return String(v || '').toLowerCase() === String(f.val || '').toLowerCase().replace(/%/g, '');
        case 'gte': return v >= f.val;
        case 'gt': return v > f.val;
        case 'lte': return v <= f.val;
        case 'lt': return v < f.val;
        case 'in': return (f.val || []).map(String).includes(String(v));
        default: return true;
      }
    });
    let out;
    if (q.op === 'insert') {
      const list = Array.isArray(q.values) ? q.values : [q.values];
      if (q.table === 'passenger_locations') {
        // Migration 046: refuse rows for a session that ended over an hour ago.
        for (const v of list) {
          const s = this.t.sessions.find(x => x.id === v.session_id);
          if (s && s.ended_at && Date.now() - Date.parse(s.ended_at) > 3600e3) return err('new row violates row-level security policy', '42501');
        }
      }
      if (q.table === 'session_passengers') {
        for (const v of list) if (rows.some(r => r.session_id === v.session_id && r.passenger_id === v.passenger_id)) return err('duplicate key value violates unique constraint', '23505');
      }
      out = list.map(v => this.insertRow(q.table, v));
      if (!q.returning) return ok(null);
    } else if (q.op === 'update') {
      out = rows.filter(match).map(r => this.updateRow(q.table, r, q.values));
      if (!q.returning) return ok(null);
    } else if (q.op === 'delete') {
      out = this.deleteRows(q.table, match);
      if (!q.returning) return ok(null);
    } else {
      out = rows.filter(match);
      if (q.table === 'tours') out = out.map(t => this.tourWithStops(t));
    }
    out = out.map(r => Object.assign({}, r));
    for (const o of (q.order || []).slice().reverse()) {
      out.sort((a, b) => (a[o.col] > b[o.col] ? 1 : a[o.col] < b[o.col] ? -1 : 0) * (o.asc ? 1 : -1));
    }
    if (q.limit != null) out = out.slice(0, q.limit);
    if (q.single === 'single') {
      if (out.length !== 1) return err('JSON object requested, multiple (or no) rows returned', 'PGRST116');
      return ok(out[0]);
    }
    if (q.single === 'maybe') return ok(out[0] || null);
    return ok(out);
  }

  // ── server functions ──
  rpc(fn, args) {
    this.log.push({ kind: 'rpc', name: fn });
    const impl = RPC[fn];
    if (!impl) { this.missing.add(fn); return err(`rig: function ${fn} is not implemented in the offline backend`, 'RIG404'); }
    try { return ok(impl.call(this, args || {})); }
    catch (e) { if (e && e.rig) return err(e.message, e.code); throw e; }
  }
  fail(message, code) { const e = new Error(message); e.rig = true; e.code = code || 'P0001'; throw e; }
  guide(token) { const g = this.t.guides.find(x => x.token && x.token === token); if (!g) this.fail('Not signed in as a guide.'); return g; }
  ownSession(id, token) {
    const g = this.guide(token); const s = this.t.sessions.find(x => x.id === id);
    if (!s) this.fail('Session not found.');
    if (s.owner_guide_id && s.owner_guide_id !== g.id) this.fail('Not your session.');
    return s;
  }
  companyOf(g) { const m = this.t.company_members.find(x => x.guide_id === g.id); return m ? { company: this.t.companies.find(c => c.id === m.company_id), role: m.role } : null; }
  ownTour(id, g) { const t = this.t.tours.find(x => x.id === id); if (!t) this.fail('Tour not found.'); if (t.owner_guide_id !== g.id) this.fail('You can only edit your own tours.'); return t; }
  slugify(name) { return (String(name || 'tour').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tour') + '-' + crypto.randomBytes(2).toString('hex'); }

  // ── seeding + simulation helpers used by the rig itself ──
  seed(seed) {
    const g = { id: uuid(), name: seed.guide.name, passkey: seed.guide.passkey, token: seed.guide.token, email: '', recovery_code: null, card_url: null, qr_code: 'rigqr1' };
    this.t.guides.push(g);
    this.addTour(seed.tour, g.id);
    return g;
  }
  addTour(def, ownerId) {
    const tour = { id: uuid(), slug: def.slug || this.slugify(def.name), name: def.name, subtitle: def.subtitle || null, home_lng: def.home_lng ?? null, home_lat: def.home_lat ?? null, owner_guide_id: ownerId || null, company_id: null };
    this.t.tours.push(tour);
    (def.stops || []).forEach((s, i) => {
      const stop = { id: this.nextId(), tour_id: tour.id, ordinal: i + 1, name: s.name, subtitle: s.subtitle || null, lng: s.lng, lat: s.lat, activation_radius_m: s.activation_radius_m || 100, drive_secs_from_prev: s.drive_secs_from_prev ?? null, name_i18n: null, subtitle_i18n: null };
      this.t.stops.push(stop);
      (s.pins || []).forEach((p, j) => this.t.pins.push({ id: this.nextId(), stop_id: stop.id, ordinal: j + 1, title: p.title, body: p.body || '', lng: p.lng, lat: p.lat, trigger_radius_m: p.trigger_radius_m || 25, category: p.category || 'pin', title_i18n: null, body_i18n: null }));
    });
    return tour;
  }
  // What the bus_gps edge function does with a tracker fix: a guide_locations
  // row with source 'bus_gps' for the session.
  busFix(sessionId, lng, lat) { return this.insertRow('guide_locations', { session_id: sessionId, source: 'bus_gps', lng, lat }); }
}

const RPC = {
  // accounts
  lookup_guide_by_token({ p_token }) { const g = this.t.guides.find(x => x.token === p_token); return g ? [{ guide_id: g.id, guide_name: g.name }] : []; },
  register_guide_open({ p_name, p_passkey, p_token, p_email, p_recovery_code }) {
    if (this.t.guides.some(g => g.name.toLowerCase() === String(p_name).toLowerCase())) this.fail('That name is taken.');
    const g = { id: uuid(), name: p_name, passkey: p_passkey, token: p_token, email: p_email || '', recovery_code: p_recovery_code || null, card_url: null, qr_code: crypto.randomBytes(4).toString('hex') };
    this.t.guides.push(g); return [{ guide_id: g.id, guide_name: g.name }];
  },
  login_guide({ p_name, p_passkey, p_new_token }) {
    const g = this.t.guides.find(x => x.name.toLowerCase() === String(p_name).toLowerCase() && x.passkey === p_passkey);
    if (!g) this.fail('Wrong name or passkey.');
    g.token = p_new_token; return [{ guide_id: g.id, guide_name: g.name }];
  },
  get_guide_account({ p_guide_token }) { const g = this.guide(p_guide_token); return [{ guide_name: g.name, email: g.email, has_passkey: !!g.passkey, has_recovery: !!g.recovery_code }]; },
  set_recovery_code({ p_guide_token, p_recovery_code }) { this.guide(p_guide_token).recovery_code = p_recovery_code; },
  get_my_guide_qr({ p_guide_token }) { return this.guide(p_guide_token).qr_code; },
  set_guide_card_url({ p_guide_token, p_card_url }) { this.guide(p_guide_token).card_url = p_card_url || null; },
  get_session_guide_card({ p_session_id }) { const s = this.t.sessions.find(x => x.id === p_session_id); const g = s && this.t.guides.find(x => x.id === s.owner_guide_id); return g ? g.card_url : null; },
  resolve_guide_qr({ p_code }) {
    const g = this.t.guides.find(x => x.qr_code === p_code); if (!g) return { found: false };
    const s = this.t.sessions.filter(x => x.owner_guide_id === g.id && !x.ended_at).sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0];
    return { found: true, guide_name: g.name, session_id: s ? s.id : null };
  },

  // tours
  list_guide_tours({ p_guide_token }) {
    const g = this.guide(p_guide_token); const co = this.companyOf(g);
    return this.t.tours.filter(t => !t.owner_guide_id || t.owner_guide_id === g.id || (co && t.company_id === co.company.id)).map(t => ({
      id: t.id, slug: t.slug, name: t.name, subtitle: t.subtitle, home_lng: t.home_lng, home_lat: t.home_lat, owner_guide_id: t.owner_guide_id,
      stop_count: this.t.stops.filter(s => s.tour_id === t.id).length, company_id: t.company_id,
      owner_name: (this.t.guides.find(x => x.id === t.owner_guide_id) || {}).name || null }));
  },
  create_tour({ p_guide_token, p_name, p_subtitle, p_home_lng, p_home_lat }) { const g = this.guide(p_guide_token); return this.addTour({ name: p_name, subtitle: p_subtitle, home_lng: p_home_lng, home_lat: p_home_lat }, g.id); },
  update_tour({ p_guide_token, p_tour_id, p_name, p_subtitle, p_home_lng, p_home_lat }) { const t = this.ownTour(p_tour_id, this.guide(p_guide_token)); Object.assign(t, { name: p_name, subtitle: p_subtitle, home_lng: p_home_lng, home_lat: p_home_lat }); return t; },
  delete_tour({ p_guide_token, p_tour_id }) {
    const t = this.ownTour(p_tour_id, this.guide(p_guide_token));
    const stopIds = this.t.stops.filter(s => s.tour_id === t.id).map(s => s.id);
    this.t.pins = this.t.pins.filter(p => !stopIds.includes(p.stop_id)); this.t.stops = this.t.stops.filter(s => s.tour_id !== t.id); this.t.tours = this.t.tours.filter(x => x !== t);
  },
  set_tour_shared({ p_guide_token, p_tour_id, p_shared }) { const g = this.guide(p_guide_token); const t = this.ownTour(p_tour_id, g); const co = this.companyOf(g); if (p_shared && !co) this.fail('You are not in a company.'); t.company_id = p_shared ? co.company.id : null; },
  create_stop({ p_guide_token, p_tour_id, p_name, p_subtitle, p_lng, p_lat, p_activation_radius_m }) {
    const t = this.ownTour(p_tour_id, this.guide(p_guide_token));
    const stop = { id: this.nextId(), tour_id: t.id, ordinal: this.t.stops.filter(s => s.tour_id === t.id).length + 1, name: p_name, subtitle: p_subtitle || null, lng: p_lng, lat: p_lat, activation_radius_m: p_activation_radius_m || 100, drive_secs_from_prev: null, name_i18n: null, subtitle_i18n: null };
    this.t.stops.push(stop); return stop;
  },
  update_stop({ p_guide_token, p_stop_id, p_name, p_subtitle, p_lng, p_lat, p_activation_radius_m }) {
    const s = this.t.stops.find(x => x.id == p_stop_id); if (!s) this.fail('Stop not found.'); this.ownTour(s.tour_id, this.guide(p_guide_token));
    Object.assign(s, { name: p_name, subtitle: p_subtitle, lng: p_lng, lat: p_lat, activation_radius_m: p_activation_radius_m }); return s;
  },
  delete_stop({ p_guide_token, p_stop_id }) {
    const s = this.t.stops.find(x => x.id == p_stop_id); if (!s) return; this.ownTour(s.tour_id, this.guide(p_guide_token));
    this.t.pins = this.t.pins.filter(p => p.stop_id !== s.id); this.t.stops = this.t.stops.filter(x => x !== s);
    this.t.stops.filter(x => x.tour_id === s.tour_id).sort((a, b) => a.ordinal - b.ordinal).forEach((x, i) => { x.ordinal = i + 1; });
  },
  reorder_stops({ p_guide_token, p_tour_id, p_stop_ids }) { this.ownTour(p_tour_id, this.guide(p_guide_token)); p_stop_ids.forEach((id, i) => { const s = this.t.stops.find(x => x.id == id); if (s) s.ordinal = i + 1; }); },
  set_tour_drive_etas({ p_guide_token, p_stop_ids, p_secs }) { this.guide(p_guide_token); (p_stop_ids || []).forEach((id, i) => { const s = this.t.stops.find(x => x.id == id); if (s) s.drive_secs_from_prev = p_secs[i]; }); },
  create_pin({ p_guide_token, p_stop_id, p_title, p_body, p_lng, p_lat, p_trigger_radius_m, p_category }) {
    const s = this.t.stops.find(x => x.id == p_stop_id); if (!s) this.fail('Stop not found.'); this.ownTour(s.tour_id, this.guide(p_guide_token));
    const pin = { id: this.nextId(), stop_id: s.id, ordinal: this.t.pins.filter(p => p.stop_id === s.id).length + 1, title: p_title, body: p_body || '', lng: p_lng, lat: p_lat, trigger_radius_m: p_trigger_radius_m || 25, category: p_category || 'pin', title_i18n: null, body_i18n: null };
    this.t.pins.push(pin); return pin;
  },
  update_pin({ p_guide_token, p_pin_id, p_title, p_body, p_lng, p_lat, p_trigger_radius_m }) {
    this.guide(p_guide_token); const p = this.t.pins.find(x => x.id == p_pin_id); if (!p) this.fail('Spot not found.');
    Object.assign(p, { title: p_title, body: p_body, lng: p_lng, lat: p_lat, trigger_radius_m: p_trigger_radius_m }); return p;
  },
  set_pin_category({ p_guide_token, p_pin_id, p_category }) { this.guide(p_guide_token); const p = this.t.pins.find(x => x.id == p_pin_id); if (!p) this.fail('Spot not found.'); p.category = p_category; return p; },
  delete_pin({ p_guide_token, p_pin_id }) { this.guide(p_guide_token); this.t.pins = this.t.pins.filter(x => x.id != p_pin_id); },
  reorder_pins({ p_guide_token, p_stop_id, p_pin_ids }) { this.guide(p_guide_token); p_pin_ids.forEach((id, i) => { const p = this.t.pins.find(x => x.id == id); if (p) p.ordinal = i + 1; }); },

  // sessions
  list_guide_sessions({ p_guide_token }) { const g = this.guide(p_guide_token); return this.t.sessions.filter(s => s.owner_guide_id === g.id).sort((a, b) => (a.started_at < b.started_at ? 1 : -1)).map(s => ({ id: s.id, label: s.label, tour_slug: s.tour_slug, started_at: s.started_at, ended_at: s.ended_at, chat_url: s.chat_url })); },
  cleanup_stale_sessions({ p_guide_token }) { this.guide(p_guide_token); return 0; },
  rename_session({ p_session_id, p_guide_token, p_label }) { const s = this.ownSession(p_session_id, p_guide_token); return this.updateRow('sessions', s, { label: p_label }); },
  end_session({ p_session_id, p_guide_token }) {
    const s = this.ownSession(p_session_id, p_guide_token);
    this.deleteRows('stop_activations', r => r.session_id === s.id);
    return this.updateRow('sessions', s, { ended_at: now() });
  },
  delete_session({ p_session_id, p_guide_token }) { const s = this.ownSession(p_session_id, p_guide_token); this.t.sessions = this.t.sessions.filter(x => x !== s); },
  start_tour({ p_session_id, p_guide_token, p_home_lng, p_home_lat }) { const s = this.ownSession(p_session_id, p_guide_token); this.updateRow('sessions', s, { tour_started_at: now(), home_lng: p_home_lng, home_lat: p_home_lat }); },
  set_session_next_stop({ p_session_id, p_guide_token, p_stop_id }) { const s = this.ownSession(p_session_id, p_guide_token); this.updateRow('sessions', s, { next_stop_id: p_stop_id == null ? null : Number(p_stop_id) }); },
  set_session_chat_url({ p_session_id, p_guide_token, p_chat_url }) { const s = this.ownSession(p_session_id, p_guide_token); return this.updateRow('sessions', s, { chat_url: p_chat_url || null }); },
  activate_stop({ p_session_id, p_stop_id, p_guide_token, p_duration_minutes, p_notes, p_warning_level }) {
    const s = this.ownSession(p_session_id, p_guide_token);
    if (s.ended_at) this.fail('This session has ended.');
    const ex = this.t.stop_activations.find(r => r.session_id === s.id && r.stop_id == p_stop_id);
    if (ex) return ex;
    return this.insertRow('stop_activations', { session_id: s.id, stop_id: Number(p_stop_id), duration_minutes: p_duration_minutes ?? 20, notes: p_notes ?? null, warning_level: p_warning_level || 'none' });
  },
  deactivate_stop({ p_session_id, p_stop_id, p_guide_token }) { const s = this.ownSession(p_session_id, p_guide_token); this.deleteRows('stop_activations', r => r.session_id === s.id && r.stop_id == p_stop_id); return { ok: true }; },
  update_stop_activation_notes({ p_session_id, p_stop_id, p_guide_token, p_notes, p_warning_level, p_duration_minutes }) {
    const s = this.ownSession(p_session_id, p_guide_token);
    const r = this.t.stop_activations.find(x => x.session_id === s.id && x.stop_id == p_stop_id); if (!r) this.fail('Stop is not active.');
    const patch = { notes: p_notes ?? null }; if (p_warning_level != null) patch.warning_level = p_warning_level; if (p_duration_minutes != null) patch.duration_minutes = p_duration_minutes;
    return this.updateRow('stop_activations', r, patch);
  },
  reset_bus_headcount({ p_session_id, p_guide_token }) { const s = this.ownSession(p_session_id, p_guide_token); this.t.session_passengers.filter(r => r.session_id === s.id && r.in_bus).forEach(r => this.updateRow('session_passengers', r, { in_bus: false })); },

  // passengers
  touch_passenger_presence({ p_session_id, p_passenger_id }) { const r = this.t.session_passengers.find(x => x.session_id === p_session_id && x.passenger_id === p_passenger_id); if (r) this.updateRow('session_passengers', r, { last_seen: now() }); },
  mark_passenger_in_bus({ p_session_id, p_passenger_id }) { const r = this.t.session_passengers.find(x => x.session_id === p_session_id && x.passenger_id === p_passenger_id); if (r) this.updateRow('session_passengers', r, { in_bus: true }); },
  log_spot_arrival({ p_session_id, p_passenger_id, p_pin_id, p_pin_title }) {
    if (this.t.spot_arrivals.some(r => r.session_id === p_session_id && r.passenger_id === p_passenger_id && r.pin_id == p_pin_id)) return;
    this.insertRow('spot_arrivals', { session_id: p_session_id, passenger_id: p_passenger_id, pin_id: p_pin_id, pin_title: p_pin_title });
  },
  list_push_passengers() { return []; },
  save_push_subscription() {}, save_native_push_token() {}, unsubscribe_push_subscription() {}, save_guide_push_target() {}, delete_guide_push_target() {},

  // chat (enough for the unread badges and a simple exchange)
  claim_session_chat_key() { return true; },
  session_chat_latest({ p_session_id }) { const m = this.t.session_chat.filter(x => x.session_id === p_session_id); return { last_id: m.length ? m[m.length - 1].id : 0 }; },
  list_session_chat({ p_session_id, p_thread_passenger_id, p_after_id, p_guide_token, p_passenger_id }) {
    const asGuide = !!p_guide_token;
    return this.t.session_chat.filter(m => m.session_id === p_session_id && (m.thread_passenger_id || null) === (p_thread_passenger_id || null) && m.id > (p_after_id || 0))
      .map(m => ({ id: m.id, sender_role: m.sender_role, sender_name: m.sender_name, body: m.body, media_url: m.media_url, created_at: m.created_at, mine: asGuide ? m.sender_role === 'guide' : m.sender_passenger_id === p_passenger_id }));
  },
  list_session_chat_threads() { return []; },
  post_session_chat(a) {
    const asGuide = !!a.p_guide_token;
    const sp = this.t.session_passengers.find(x => x.session_id === a.p_session_id && x.passenger_id === a.p_passenger_id);
    const m = { id: this.nextId(), session_id: a.p_session_id, thread_passenger_id: a.p_thread_passenger_id || null, sender_role: asGuide ? 'guide' : 'passenger', sender_passenger_id: asGuide ? null : a.p_passenger_id, sender_name: asGuide ? this.guide(a.p_guide_token).name : (sp ? sp.name : 'Passenger'), body: a.p_body || '', media_url: a.p_media_url || null, created_at: now() };
    this.t.session_chat.push(m); return { id: m.id };
  },
  list_guide_chat() { return []; },

  // company level (migration 051) — the parts the Company screen and bus picker read
  get_company({ p_guide_token }) {
    const g = this.guide(p_guide_token); const co = this.companyOf(g); if (!co) return null;
    const c = co.company;
    return { id: c.id, name: c.name, my_role: co.role, role: co.role, bus_gps_key: c.bus_gps_key, bus_feed_url: c.bus_feed_url || null, sms_provider: c.sms_provider || null,
      members: this.t.company_members.filter(m => m.company_id === c.id).map(m => ({ id: m.guide_id, name: (this.t.guides.find(x => x.id === m.guide_id) || {}).name, role: m.role })),
      buses: this.t.buses.filter(b => b.company_id === c.id) };
  },
  create_company({ p_guide_token, p_name }) {
    const g = this.guide(p_guide_token); if (this.companyOf(g)) this.fail('You are already in a company.');
    const c = { id: uuid(), name: p_name, bus_gps_key: crypto.randomBytes(12).toString('hex') };
    this.t.companies.push(c); this.t.company_members.push({ company_id: c.id, guide_id: g.id, role: 'admin' }); return { id: c.id, name: c.name };
  },
  save_bus({ p_guide_token, p_name, p_tracker_id, p_bus_id }) {
    const g = this.guide(p_guide_token); const co = this.companyOf(g);
    let b = p_bus_id && this.t.buses.find(x => x.id === p_bus_id);
    if (b) Object.assign(b, { name: p_name, tracker_id: p_tracker_id || null });
    else { b = { id: uuid(), name: p_name, tracker_id: p_tracker_id || null, company_id: co ? co.company.id : null, owner_guide_id: co ? null : g.id }; this.t.buses.push(b); }
    return b;
  },
  delete_bus({ p_guide_token, p_bus_id }) { this.guide(p_guide_token); this.t.buses = this.t.buses.filter(b => b.id !== p_bus_id); },
  set_session_bus({ p_session_id, p_guide_token, p_bus_id }) { const s = this.ownSession(p_session_id, p_guide_token); this.updateRow('sessions', s, { bus_id: p_bus_id || null }); },
  list_company_live_sessions() { return []; },
};

module.exports = { Backend };
