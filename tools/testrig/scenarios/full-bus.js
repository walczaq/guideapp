// A full bus: 19 passengers walking the Geysir spots at once, seen from the
// guide's phone. The passengers are rows written straight into the backend
// (no 19 browser windows), which is what the guide's phone receives anyway.
//   node tools/testrig/scenarios/full-bus.js
const { Rig, sleep, densify } = require('../rig');

(async () => {
  const rig = await Rig.start();
  rig.verbose = process.env.V === '1';
  const stop = rig.tour().stops.find(s => s.name === 'Geysir');
  const PARKING = [stop.lat, stop.lng];
  const spots = stop.pins.filter(p => p.category === 'pin' || p.category === 'side').map(p => [p.lat, p.lng]);
  const sid = rig.createSession();
  const guide = await rig.openGuide(sid, { at: PARKING });
  await sleep(2500);
  await rig.startTour(guide, 'Geysir');
  await rig.activateStop(guide, 'Geysir');

  const names = ['Anna', 'Ben', 'Cara', 'Dmitri', 'Elín', 'Farid', 'Guðrún', 'Hiro', 'Ines', 'Jón', 'Kasia', 'Liam', 'María', 'Noor', 'Ólafur', 'Priya', 'Quentin', 'Rósa', 'Sven'];
  const pax = names.map((name, i) => {
    rig.backend.insertRow('session_passengers', { session_id: sid, passenger_id: 'pax' + i, name });
    // Everyone walks the same loop, each at their own pace and a few metres off the line.
    const off = [(Math.sin(i * 2.4) * 8) / 111320, (Math.cos(i * 1.7) * 8) / 48000];
    return { id: 'pax' + i, path: densify([PARKING, ...spots], 1.0 + (i % 5) * 0.25).map(p => [p[0] + off[0], p[1] + off[1]]), at: 0 };
  });
  await rig.hold(guide, PARKING, 1000);
  await rig.tap(guide, '#zoom-detail', { settle: 2000 });
  await guide.evaluate((c) => map.jumpTo({ center: [c[1], c[0] + 0.0018], zoom: 15.6 }), PARKING);

  // 90 s of walking, a fix per passenger every 5 s (the app's upload cadence), 6 m/s.
  const frame = () => guide.evaluate(() => new Promise(res => { let n = 0, t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 > 2000) res(Math.round(n / 2)); else requestAnimationFrame(f); }; requestAnimationFrame(f); }));
  for (let t = 0; t < 18; t++) {
    for (const p of pax) {
      p.at = Math.min(p.path.length - 1, p.at + 30);
      rig.backend.insertRow('passenger_locations', { session_id: sid, passenger_id: p.id, lng: p.path[p.at][1], lat: p.path[p.at][0], accuracy: 6, client_recorded_at: new Date().toISOString() });
    }
    await rig.hold(guide, PARKING, 5000);
    if (t === 8) await rig.shot(guide, 'f01-guide-19-walking');
  }
  await rig.shot(guide, 'f02-guide-19-end');
  const fps = await frame();
  // Pinch-zoom while 19 trails are on screen — the case that used to stutter.
  const t0 = Date.now();
  await guide.evaluate(() => new Promise(res => { map.once('moveend', res); map.easeTo({ zoom: map.getZoom() + 1.5, duration: 2000 }); }));
  const zoomMs = Date.now() - t0;
  const s = await guide.evaluate(() => ({ dots: document.querySelectorAll('#passengers-layer .passenger-dot').length, trailPaths: document.querySelectorAll('#passengers-layer .passenger-trail').length, listed: PASSENGERS.size, count: (document.querySelector('.passenger-count, #passenger-count') || {}).innerText || null }));
  await rig.shot(guide, 'f03-guide-zoomed');
  console.log(JSON.stringify({ ...s, idleFps: fps, twoSecondZoomTookMs: zoomMs, pageErrors: rig.errors, functionsNotInRig: [...rig.backend.missing] }, null, 2));
  await rig.stop();
})().catch((e) => { console.error(e); process.exit(1); });
