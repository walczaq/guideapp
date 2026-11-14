// Made-up test tour for the offline rig: three Golden Circle stops with spots
// placed roughly where the real sights are. Coordinates are approximate —
// good for walking tests, not for navigation. Replace or extend freely.
const pin = (title, lat, lng, category = 'pin', radius = 25, body = '') =>
  ({ title, body: body || `${title} — test note for the offline rig.`, lat, lng, trigger_radius_m: radius, category });

module.exports = {
  guide: { name: 'Rig Guide', passkey: 'rig-passkey', token: 'rig-guide-token-0000000000000000' },
  tour: {
    slug: 'rig-golden-circle', name: 'Golden Circle (rig)', subtitle: 'Offline test tour',
    home_lng: -21.9330, home_lat: 64.1420,   // Reykjavík, roughly BSÍ
    stops: [
      { name: 'Þingvellir', subtitle: 'Rift valley', lat: 64.2559, lng: -21.1300, activation_radius_m: 300, drive_secs_from_prev: 2700, pins: [
        pin('Hakið viewpoint', 64.2556, -21.1292),
        pin('Almannagjá gorge', 64.2585, -21.1247),
        pin('Lögberg', 64.2609, -21.1213),
        pin('Drekkingarhylur', 64.2625, -21.1195, 'side'),
        pin('Öxarárfoss', 64.2658, -21.1172, 'pin', 30),
        pin('Toilets', 64.2553, -21.1304, 'toilet'),
        pin('Cliff edge', 64.2596, -21.1242, 'danger', 30),
      ] },
      { name: 'Geysir', subtitle: 'Hot springs', lat: 64.3104, lng: -20.3024, activation_radius_m: 250, drive_secs_from_prev: 3000, pins: [
        pin('Litli Geysir', 64.3112, -20.3017, 'pin', 15),
        pin('Strokkur', 64.3127, -20.3008, 'pin', 25),
        pin('Blesi', 64.3134, -20.3016, 'side', 15),
        pin('Great Geysir', 64.3138, -20.2995, 'pin', 25),
        pin('Hill viewpoint', 64.3131, -20.3040, 'pin', 25),
        pin('Café', 64.3098, -20.3030, 'cafe'),
        pin('Souvenirs', 64.3096, -20.3036, 'souvenir'),
        pin('Hot water', 64.3129, -20.3002, 'danger', 20),
      ] },
      { name: 'Gullfoss', subtitle: 'Waterfall', lat: 64.3255, lng: -20.1295, activation_radius_m: 250, drive_secs_from_prev: 600, pins: [
        pin('Upper viewpoint', 64.3262, -20.1262),
        pin('Stairs', 64.3258, -20.1249, 'pin', 15),
        pin('Lower path', 64.3266, -20.1227),
        pin('Falls edge', 64.3273, -20.1213, 'pin', 20),
        pin('Toilets', 64.3252, -20.1301, 'toilet'),
        pin('Wet rock', 64.3276, -20.1208, 'danger', 20),
      ] },
    ],
  },
};
