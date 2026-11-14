// One stop, start to finish: a guide starts the tour and activates Geysir, a
// passenger walks the spots in order and comes back, while the bus (tracker
// feed) drives in from the main road. Screenshots land in tools/testrig/out/.
//
//   node tools/testrig/scenarios/geysir-walk.js
const { Rig, sleep } = require('../rig');

(async () => {
  const rig = await Rig.start();
  rig.verbose = process.env.V === '1';
  const stop = rig.tour().stops.find(s => s.name === 'Geysir');
  const spots = stop.pins.filter(p => p.category === 'pin' || p.category === 'side');
  const PARKING = [stop.lat, stop.lng];
  const sid = rig.createSession();

  const guide = await rig.openGuide(sid, { at: PARKING });
  const pax = await rig.openPassenger(sid, { at: [PARKING[0] - 0.0001, PARKING[1] - 0.0002] });
  await sleep(2500);
  await rig.joinAsPassenger(pax, 'Anna');
  await rig.shot(pax, '01-passenger-joined');
  await rig.shot(guide, '02-guide-boarding');

  await rig.startTour(guide, 'Geysir');
  await rig.activateStop(guide, 'Geysir', { minutes: 30 });
  rig.placeBusPin(sid, PARKING);
  await sleep(1500);
  await rig.shot(pax, '03-passenger-stop-card');
  await rig.tap(pax, '#stop-arrival-ok');
  await rig.shot(pax, '04-passenger-stop-active');
  const bannerHidden = await pax.evaluate(() => document.getElementById('next-stop-banner').hidden);

  // Walk the spots in order. Each arrival popup is photographed, then closed.
  let n = 0, arrivals = 0;
  const onStep = async () => {
    n += 1;
    if (await pax.locator('#popup.show').count()) {
      arrivals += 1;
      await rig.shot(pax, `05-arrival-${arrivals}`);
      await pax.evaluate(() => closePopup());
    }
    if (n % 60 === 0) await rig.shot(pax, `06-walking-${n / 60}`);
  };
  await rig.walk(pax, [PARKING, ...spots.map(p => [p.lat, p.lng])], { speed: 6, everyMs: 500, onStep });
  await rig.shot(pax, '07-passenger-at-last-spot');
  await rig.tap(guide, '#zoom-detail', { settle: 2500 });   // guide opens on the whole-tour overview
  await rig.shot(guide, '08-guide-sees-walk');

  // Bus drives in on the tracker feed while the passenger walks back.
  const busRoute = [[64.3082, -20.3170], [64.3092, -20.3090], PARKING];
  const bus = rig.driveBus(sid, busRoute, { speed: 14, everyMs: 1000 });
  await sleep(4000);
  await rig.shot(pax, '09-passenger-bus-approaching');
  await rig.walk(pax, [[spots[spots.length - 1].lat, spots[spots.length - 1].lng], PARKING], { speed: 6, everyMs: 500, onStep });
  await bus;
  await sleep(1500);
  await rig.shot(pax, '10-passenger-back-at-bus');
  await rig.shot(guide, '11-guide-end');

  const sp = rig.backend.t.session_passengers[0];
  console.log(JSON.stringify({
    spotArrivals: rig.backend.t.spot_arrivals.map(a => a.pin_title),
    passengerFixesUploaded: rig.backend.t.passenger_locations.length,
    busFixes: rig.backend.t.guide_locations.filter(r => r.source === 'bus_gps').length,
    passengerMarkedInBus: sp && sp.in_bus,
    nextBannerHiddenDuringStop: bannerHidden,
    pageErrors: rig.errors,
    functionsNotInRig: [...rig.backend.missing],
    out: rig.outDir,
  }, null, 2));
  await rig.stop();
})().catch((e) => { console.error(e); process.exit(1); });
