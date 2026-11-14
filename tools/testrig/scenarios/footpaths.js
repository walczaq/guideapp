// Footpath trails, on the real map: the guide opens the tour in the builder
// (which fetches walking paths from Mapbox and saves them on the stops), then
// a passenger at an active stop sees the spot trail follow those paths.
//   RIG_MAP=mapbox node tools/testrig/scenarios/footpaths.js
const { Rig, sleep } = require('../rig');

(async () => {
  const rig = await Rig.start({ map: 'mapbox' });
  rig.verbose = process.env.V === '1';
  const builder = await rig.openGuide(null, { label: 'builder' });
  await sleep(3000);
  await rig.tap(builder, '#sm-build');
  await rig.tap(builder, 'Edit', { settle: 3000 });
  // Wait for the builder's quiet footpath run to finish (one request per leg).
  const legCount = () => rig.backend.t.stops.map(s => s.walk_path ? Object.keys(s.walk_path.legs).length : 0);
  let prev = '', same = 0;
  for (let i = 0; i < 60 && same < 4; i++) { await sleep(1000); const now = JSON.stringify(legCount()); same = now === prev ? same + 1 : 0; prev = now; }
  const summary = rig.backend.t.stops.map(s => ({ stop: s.name, legs: Object.entries((s.walk_path || { legs: {} }).legs).map(([k, v]) => v.length ? v.length + ' pts' : 'straight') }));
  console.log(JSON.stringify(summary));

  for (const [name, centre, zoom] of [['Geysir', [-20.3015, 64.3120], 15.6], ['Þingvellir', [-21.1235, 64.2605], 14.4], ['Gullfoss', [-20.1250, 64.3264], 15.6]]) {
    await builder.locator('.tb-stop-marker', { hasText: String(rig.tour().stops.find(s => s.name === name).ordinal) }).first().click({ force: true }).catch(() => {});
    await sleep(600);
    await builder.evaluate(([c, z, n]) => { const st = _tbTour.stops.find(s => s.name === n); _tbSelStopId = st.id; _tbEditorMap.jumpTo({ center: c, zoom: z }); renderTbMarkers(); }, [centre, zoom, name]);
    await sleep(3500);
    await rig.shot(builder, 'p-builder-' + name.replace(/[^a-z]/gi, ''));
  }

  await builder.context().close();

  // Passenger at Geysir with the stop active.
  const stop = rig.tour().stops.find(s => s.name === 'Geysir');
  const sid = rig.createSession();
  const guide = await rig.openGuide(sid, { at: [stop.lat, stop.lng] });
  const pax = await rig.openPassenger(sid, { at: [stop.lat, stop.lng] });
  await sleep(3000);
  await rig.joinAsPassenger(pax, 'Anna');
  await rig.startTour(guide, 'Geysir');
  await rig.activateStop(guide, 'Geysir');
  await sleep(1500);
  await rig.tap(pax, '#stop-arrival-ok');
  await pax.evaluate(() => map.jumpTo({ center: [-20.3015, 64.3120], zoom: 16 }));
  await sleep(4000);
  const drawn = await pax.evaluate(() => [...document.querySelectorAll('#pins-layer .spot-trail')].map(p => p.__geoPts.length));
  await rig.shot(pax, 'p-passenger-geysir');
  console.log(JSON.stringify({ passengerTrailPointCounts: drawn, pageErrors: rig.errors, functionsNotInRig: [...rig.backend.missing] }));
  await rig.stop();
})().catch((e) => { console.error(e); process.exit(1); });
