// A longer day at the made-up Þingvellir stop, with pass/fail checks:
// geofence prompt, walking spots + an extra + a danger zone, a late joiner,
// a reload mid-stop, a passenger without location, ending the stop, ending
// the session.   node tools/testrig/scenarios/thingvellir-day.js
const { Rig, sleep } = require('../rig');

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); };

(async () => {
  const rig = await Rig.start();
  rig.verbose = process.env.V === '1';
  const stop = rig.tour().stops.find(s => s.name === 'Þingvellir');
  const byTitle = (t) => { const p = stop.pins.find(x => x.title === t); return [p.lat, p.lng]; };
  const PARKING = [stop.lat, stop.lng];
  const FAR = [stop.lat - 0.02, stop.lng - 0.04];   // ~3 km out, on the road in
  const sid = rig.createSession();

  // Guide and first passenger board away from the stop.
  const guide = await rig.openGuide(sid, { at: FAR });
  const anna = await rig.openPassenger(sid, { at: FAR, label: 'anna' });
  await sleep(2500);
  await rig.joinAsPassenger(anna, 'Anna');
  await rig.startTour(guide, 'Þingvellir');
  await sleep(800);
  const paxState = (pg) => pg.evaluate(() => ({
    active: ACTIVE_STOP_IDS.size,
    nextBanner: !document.getElementById('next-stop-banner').hidden && document.getElementById('next-stop-banner').innerText.replace(/\s+/g, ' '),
    pins: document.querySelectorAll('#pins-layer .pin-group').length,
    extras: document.querySelectorAll('#pins-layer .amenity-group').length,
    zones: document.querySelectorAll('#pins-layer .zone-group').length,
    spotTrail: document.querySelectorAll('#pins-layer .spot-trail').length,
    breadcrumb: document.querySelectorAll('#you-layer path').length,
    busMarkers: document.querySelectorAll('.mapboxgl-marker').length,
    popup: document.getElementById('popup').classList.contains('show') ? document.getElementById('popup-title').innerText : null,
  }));
  let st = await paxState(anna);
  check('in transit: passenger sees the Next banner, no spots', st.nextBanner && /Þingvellir/.test(st.nextBanner) && st.pins === 0, st);
  await rig.shot(anna, 't01-passenger-transit');

  // Guide arrives → geofence prompt after a short dwell → activate from it.
  await rig.hold(guide, PARKING, 6000);
  const prompted = await guide.locator('#stop-modal-backdrop').evaluate(el => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0).catch(() => false);
  check('guide arriving at the stop gets the "start this stop?" prompt', prompted, { title: await guide.locator('#stop-modal-title').innerText().catch(() => null) });
  await rig.shot(guide, 't02-guide-geofence-prompt');
  if (prompted) await rig.tap(guide, '#stop-modal-activate', { settle: 1500 });
  else await rig.activateStop(guide, 'Þingvellir');
  rig.placeBusPin(sid, PARKING);
  await sleep(1500);
  check('passenger gets the stop card', await anna.locator('#stop-arrival-ok').isVisible().catch(() => false));
  await rig.tap(anna, '#stop-arrival-ok');
  st = await paxState(anna);
  check('stop active: spots, extra, zone and spot trail drawn; Next banner gone', st.pins === 4 && st.zones === 1 && st.spotTrail === 2 && !st.nextBanner, st);

  // Anna walks: parking → 1 → 2 → through the danger zone → 3 → extra 3B.
  const seen = [];
  const onStep = async () => {
    const title = await anna.evaluate(() => document.getElementById('popup').classList.contains('show') ? document.getElementById('popup-title').innerText + (document.getElementById('popup').classList.contains('warn') ? ' [warning]' : '') : null);
    if (title) { seen.push(title); if (seen.length <= 6) await rig.shot(anna, `t03-popup-${seen.length}`); await anna.evaluate(() => closePopup()); }
  };
  await rig.walk(anna, [PARKING], { everyMs: 300 });
  await rig.walk(anna, [PARKING, byTitle('Hakið viewpoint'), byTitle('Almannagjá gorge'), byTitle('Cliff edge'), byTitle('Lögberg'), byTitle('Drekkingarhylur')], { speed: 6, everyMs: 500, onStep });
  await sleep(500); await onStep();
  check('arrival popups for spots 1, 2, 3 and the extra', ['Hakið viewpoint', 'Almannagjá gorge', 'Lögberg', 'Drekkingarhylur'].every(t => seen.includes(t)), seen);
  check('danger zone warning on entering "Cliff edge"', seen.some(t => /Cliff edge/.test(t) && /warning/.test(t)), seen);
  st = await paxState(anna);
  check('breadcrumb drawn behind the walking passenger', st.breadcrumb > 5, st.breadcrumb);
  await rig.shot(anna, 't04-anna-walked');

  // Late joiner: opens the link mid-stop, standing at the parking.
  const ben = await rig.openPassenger(sid, { at: PARKING, label: 'ben' });
  await sleep(2500);
  await rig.joinAsPassenger(ben, 'Ben');
  await sleep(1500);
  if (await ben.locator('#stop-arrival-ok').isVisible().catch(() => false)) await rig.tap(ben, '#stop-arrival-ok');
  st = await paxState(ben);
  check('late joiner sees the active stop (spots + spot trail), no Next banner', st.active === 1 && st.pins === 4 && st.spotTrail === 2 && !st.nextBanner, st);
  await rig.shot(ben, 't05-late-joiner');

  // Passenger without location permission.
  const cara = await rig.openPassenger(sid, { label: 'cara' });
  await sleep(2500);
  await rig.joinAsPassenger(cara, 'Cara').catch(async (e) => { console.log('  (join without location needed other taps: ' + e.message.split('\n')[0] + ')'); console.log('  controls:', JSON.stringify(await rig.controls(cara))); });
  await sleep(1500);
  if (await cara.locator('#stop-arrival-ok').isVisible().catch(() => false)) await rig.tap(cara, '#stop-arrival-ok');
  st = await paxState(cara).catch(() => null);
  check('passenger without location still sees the stop', st && st.pins === 4, st);
  await rig.shot(cara, 't06-no-location');

  // Reload mid-stop: breadcrumb and stop state come back.
  const before = (await paxState(anna)).breadcrumb;
  await anna.reload({ waitUntil: 'load' });
  await sleep(4000);
  if (await anna.locator('#stop-arrival-ok').isVisible().catch(() => false)) await rig.tap(anna, '#stop-arrival-ok');
  await rig.hold(anna, byTitle('Drekkingarhylur'), 2000);
  st = await paxState(anna);
  check('after a reload mid-stop the passenger is back on the map with the stop and breadcrumb', st.active === 1 && st.pins === 4 && st.breadcrumb >= before - 2, { before, after: st });
  await rig.shot(anna, 't07-anna-reloaded');

  // Guide's view of the group.
  await rig.hold(guide, PARKING, 1500);
  await rig.tap(guide, '#zoom-detail', { settle: 2500 });
  const g = await guide.evaluate(() => ({ dots: document.querySelectorAll('#passengers-layer .passenger-dot').length, trails: document.querySelectorAll('#passengers-layer .passenger-trail').length, names: [...PASSENGERS.values()].map(p => p.name) }));
  check('guide sees all three passengers by name, two with positions', g.names.length === 3 && g.dots === 2, g);
  await rig.shot(guide, 't08-guide-group');

  // Guide ends the stop (End stop → confirm), then names the next one.
  await rig.tap(guide, '#stop-timer-end', { settle: 1000 });
  await rig.tap(guide, '#stop-modal-activate', { settle: 1500 });   // the dialog's button reads "Deactivate" here
  await rig.shot(guide, 't09-guide-after-end-stop');
  await sleep(1000);
  // Anna has not moved since the stop ended — her map must clear without a new GPS fix.
  st = await paxState(anna);
  check('stop ended: spots and spot trail leave the passenger map', rig.backend.t.stop_activations.length === 0 && st.active === 0 && st.pins === 0 && st.spotTrail === 0, { activations: rig.backend.t.stop_activations.length, st });
  check('stop ended: breadcrumb clears at once, without waiting for the next GPS fix', st.breadcrumb === 0, st.breadcrumb);
  await rig.shot(anna, 't10-passenger-after-stop');
  check('stop ended: passenger trails leave the guide map too', (await guide.evaluate(() => document.querySelectorAll('#passengers-layer .passenger-trail').length)) === 0);
  if (await guide.locator('.nsp-stop').count()) await guide.locator('.nsp-stop', { hasText: 'Geysir' }).click();
  await sleep(1500);
  st = await paxState(ben);
  check('back in transit: Next banner shows the stop the guide picked', st.nextBanner && /Geysir/.test(st.nextBanner), st.nextBanner);
  await rig.shot(ben, 't11-passenger-next-geysir');

  // Guide ends the session from the control center.
  await guide.evaluate(() => { const b = document.getElementById('end-session-btn'); if (b) b.scrollIntoView(); });
  console.log('  guide controls before ending:', JSON.stringify(await rig.controls(guide)));
  rig.backend.rpc('end_session', { p_session_id: sid, p_guide_token: rig.guideAccount.token });
  await sleep(2000);
  const ended = await ben.locator('#session-ended-screen').evaluate(el => getComputedStyle(el).display !== 'none').catch(() => false);
  check('session ended: passenger sees the ended screen', ended);
  await rig.shot(ben, 't12-passenger-session-ended');

  console.log(JSON.stringify({ failed: results.filter(r => !r.ok).map(r => r.name), pageErrors: rig.errors, functionsNotInRig: [...rig.backend.missing] }, null, 2));
  await rig.stop();
})().catch((e) => { console.error(e); process.exit(1); });
