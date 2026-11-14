// Pickup, before the tour starts: a passenger waits at a hotel while the bus
// (tracker feed) drives in. Checks the "your bus is on its way" banner, the
// moving bus icon, arrival, a stale tracker, and that the banner leaves once
// the tour starts.   node tools/testrig/scenarios/pickup-bus.js
const { Rig, sleep } = require('../rig');

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); };

(async () => {
  const rig = await Rig.start();
  rig.verbose = process.env.V === '1';
  const HOTEL = [64.1466, -21.9426];
  const DEPOT = [64.1330, -21.8980];   // ~2.6 km away
  const sid = rig.createSession();
  const guide = await rig.openGuide(sid, { at: DEPOT });
  const anna = await rig.openPassenger(sid, { at: HOTEL, label: 'anna' });
  const cara = await rig.openPassenger(sid, { label: 'cara' });   // location denied
  await sleep(2500);
  await rig.joinAsPassenger(anna, 'Anna');
  await rig.joinAsPassenger(cara, 'Cara');

  const bus = (pg) => pg.evaluate(() => {
    const el = document.getElementById('bus-banner');
    const badge = document.querySelector('.bus-gps-badge');
    const r = badge && badge.getBoundingClientRect();
    return { banner: el && !el.hidden ? el.innerText.replace(/\s+/g, ' ') : null, icon: !!badge, stale: !!badge && badge.classList.contains('stale'),
      label: badge ? badge.parentElement.firstChild.textContent : null, at: r ? [Math.round(r.x), Math.round(r.y)] : null };
  });
  let b = await bus(anna);
  check('before any tracker fix: no bus banner, no bus icon', !b.banner && !b.icon, b);

  rig.backend.busFix(sid, DEPOT[1], DEPOT[0]);
  await sleep(1200);
  b = await bus(anna);
  check('first fix: banner says the bus is on its way with a distance', b.banner && /on (its|the) way/i.test(b.banner) && /km/.test(b.banner) && b.icon, b);
  const c = await bus(cara);
  check('passenger without location: banner without a distance', c.banner && !/\d/.test(c.banner), c);
  await rig.shot(anna, 'b01-bus-on-its-way');
  await rig.shot(cara, 'b02-bus-no-location');

  // Tap the banner → the map frames bus + passenger.
  await rig.tap(anna, '#bus-banner', { settle: 2500 });
  const framed = await anna.evaluate(() => { const r = document.querySelector('.bus-gps-badge').getBoundingClientRect(); return r.x > 0 && r.y > 0 && r.right < innerWidth && r.bottom < innerHeight; });
  check('tapping the banner brings the bus into view', framed);
  await rig.shot(anna, 'b03-bus-framed');

  // Bus drives to the hotel (fast: ~45 m/s so the run stays short).
  const seenBanners = new Set(); let moved = 0, last = null;
  await rig.driveBus(sid, [DEPOT, [64.1400, -21.9200], HOTEL], { speed: 45, everyMs: 1000, onStep: async (_p, i) => {
    const s = await bus(anna); if (s.banner) seenBanners.add(s.banner.replace(/[\d.,]+\s?k?m/, 'N'));
    if (last && s.at && (s.at[0] !== last[0] || s.at[1] !== last[1])) moved += 1; last = s.at;
    if (i === 30) await rig.shot(anna, 'b04-bus-halfway');
  } });
  await sleep(1200);
  b = await bus(anna);
  check('bus icon moved across the passenger map as fixes arrived', moved > 20, moved);
  check('at the hotel: banner switches to "your bus is here"', b.banner && /here|arrived/i.test(b.banner), { banner: b.banner, seen: [...seenBanners] });
  await rig.shot(anna, 'b05-bus-arrived');
  const g = await bus(guide);
  check('guide also sees the tracker bus icon, without the passenger banner', g.icon && !g.banner, g);

  // Tracker goes quiet: the last fix is 5 minutes old.
  const lastFix = rig.backend.t.guide_locations.filter(r => r.source === 'bus_gps').pop();
  rig.backend.t.guide_locations = rig.backend.t.guide_locations.filter(r => r.source !== 'bus_gps');
  rig.backend.insertRow('guide_locations', { session_id: sid, source: 'bus_gps', lng: lastFix.lng, lat: lastFix.lat, set_at: new Date(Date.now() - 5 * 60e3).toISOString() });
  await sleep(1500);
  b = await bus(anna);
  check('stale tracker: icon goes hollow and the label says how old the position is', b.stale && /5 min/.test(b.label || ''), b);
  check('stale tracker: banner no longer claims the bus is here', b.banner && !/here|arrived/i.test(b.banner), b.banner);
  await rig.shot(anna, 'b06-bus-stale');

  // A passenger who opens the link now gets the bus straight away (catch-up).
  const ben = await rig.openPassenger(sid, { at: HOTEL, label: 'ben' });
  await sleep(2500);
  await rig.joinAsPassenger(ben, 'Ben');
  await sleep(1500);
  b = await bus(ben);
  check('late joiner sees the bus icon without waiting for a new fix', b.icon, b);

  // Tour starts → the banner slot goes back to "Next".
  rig.backend.busFix(sid, HOTEL[1], HOTEL[0]);
  await rig.startTour(guide, 'Þingvellir');
  await sleep(1500);
  b = await bus(anna);
  const next = await anna.evaluate(() => !document.getElementById('next-stop-banner').hidden && document.getElementById('next-stop-banner').innerText.replace(/\s+/g, ' '));
  check('tour started: bus banner gone, Next banner shown, bus icon stays', !b.banner && b.icon && /Þingvellir/.test(next || ''), { b, next });
  await rig.shot(anna, 'b07-tour-started');

  console.log(JSON.stringify({ failed: results.filter(r => !r.ok).map(r => r.name), pageErrors: rig.errors, functionsNotInRig: [...rig.backend.missing] }, null, 2));
  await rig.stop();
})().catch((e) => { console.error(e); process.exit(1); });
