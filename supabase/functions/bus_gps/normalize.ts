// Turns whatever a fleet-tracking platform sends into the one shape
// ingest_bus_positions (migration 050) understands:
//
//   { ids: string[], lng: number, lat: number, heading?: number, speed?: number, ts?: string }
//
// The fleet platform isn't fixed yet, so this is deliberately forgiving: it
// finds the list of vehicles wherever it sits in the payload, looks inside the
// usual nested "position"/"location" objects, and recognises the common field
// spellings. `ids` collects EVERY identifier a vehicle carries (id, name,
// plate, IMEI …) — a bus matches if its tracker ID in Fieldnote equals any of
// them, so the guide can type whichever one they see in the fleet system.
//
// Pure functions, no Deno APIs — runnable under plain Node for testing.

export interface BusPosition {
  ids: string[];
  lng: number;
  lat: number;
  heading?: number;
  speed?: number;
  ts?: string;
}

const LIST_KEYS = ['vehicles', 'positions', 'data', 'items', 'results', 'units', 'devices',
  'assets', 'objects', 'features', 'records', 'rows', 'list', 'value'];
const NEST_KEYS = ['position', 'location', 'gps', 'lastposition', 'last_position', 'lastlocation',
  'last_location', 'lastknownposition', 'lastknownlocation', 'coordinates', 'coordinate', 'coords',
  'latlng', 'point', 'state', 'status', 'properties', 'attributes', 'vehicle', 'unit', 'device', 'asset'];
const ID_KEYS = ['id', 'vehicleid', 'vehicle_id', 'unitid', 'unit_id', 'deviceid', 'device_id',
  'assetid', 'asset_id', 'objectid', 'trackerid', 'tracker_id', 'imei', 'serial', 'serialnumber',
  'name', 'vehiclename', 'vehicle_name', 'label', 'displayname', 'alias', 'number', 'vehiclenumber',
  'fleetnumber', 'plate', 'licenseplate', 'license_plate', 'numberplate', 'registration',
  'registrationnumber', 'regnumber', 'reg', 'vin', 'externalid', 'external_id', 'bus'];
const LAT_KEYS = ['lat', 'latitude', 'y'];
const LNG_KEYS = ['lng', 'lon', 'long', 'longitude', 'x'];
const HEADING_KEYS = ['heading', 'headingdegrees', 'course', 'bearing', 'direction', 'angle', 'azimuth'];
const SPEED_KEYS = ['speed', 'speedkmh', 'speed_kmh', 'speedkph', 'velocity', 'kmh'];
const TIME_KEYS = ['ts', 'time', 'timestamp', 'fixtime', 'fix_time', 'gpstime', 'gps_time', 'datetime',
  'date_time', 'recordedat', 'recorded_at', 'updatedat', 'updated_at', 'lastupdate', 'last_update',
  'devicetime', 'servertime', 'positiontime', 'reportedat', 'reported_at', 'date', 't'];

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

// Case-insensitive key lookup over an object, first match in `keys` order.
function pick(o: Record<string, unknown>, keys: string[]): unknown {
  const lower: Record<string, unknown> = {};
  for (const k of Object.keys(o)) lower[k.toLowerCase()] = o[k];
  for (const k of keys) {
    const v = lower[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim().replace(',', '.'));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// Epoch seconds / milliseconds or any Date-parsable string → ISO string.
function toIso(v: unknown): string | undefined {
  let ms: number | undefined;
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{9,14}$/.test(v.trim()) ? Number(v) : undefined);
  if (n !== undefined && Number.isFinite(n)) {
    ms = n < 1e11 ? n * 1000 : n;
  } else if (typeof v === 'string') {
    const p = Date.parse(v);
    if (Number.isFinite(p)) ms = p;
  }
  if (ms === undefined || ms < Date.UTC(2015, 0, 1)) return undefined;
  return new Date(ms).toISOString();
}

// The vehicle object itself plus the nested objects positions usually hide in
// (two levels: e.g. { vehicle: {...}, lastPosition: { coordinates: {...} } }).
function layers(item: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [item];
  const lowerNest = new Set(NEST_KEYS);
  for (let depth = 0, from = 0; depth < 2; depth++) {
    const end = out.length;
    for (let i = from; i < end; i++) {
      for (const k of Object.keys(out[i])) {
        const v = out[i][k];
        if (isObj(v) && lowerNest.has(k.toLowerCase())) out.push(v);
      }
    }
    from = end;
  }
  return out;
}

function normalizeOne(item: unknown): BusPosition | null {
  if (!isObj(item)) return null;
  const ls = layers(item);

  let lat: number | undefined;
  let lng: number | undefined;
  for (const l of ls) {
    const la = num(pick(l, LAT_KEYS));
    const lo = num(pick(l, LNG_KEYS));
    if (la !== undefined && lo !== undefined) { lat = la; lng = lo; break; }
  }
  // GeoJSON: geometry.coordinates = [lng, lat]. Also a bare [lng, lat] pair
  // under "coordinates"/"location".
  if (lat === undefined) {
    const candidates: unknown[] = [];
    const geo = pick(item, ['geometry']);
    if (isObj(geo)) candidates.push(geo.coordinates);
    for (const l of ls) candidates.push(pick(l, ['coordinates', 'coords', 'location', 'position']));
    for (const c of candidates) {
      if (Array.isArray(c) && c.length >= 2) {
        const lo = num(c[0]);
        const la = num(c[1]);
        if (la !== undefined && lo !== undefined) { lat = la; lng = lo; break; }
      }
    }
  }
  if (lat === undefined || lng === undefined) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;          // tracker without a fix

  const ids: string[] = [];
  const lowerIds = new Set(ID_KEYS);
  for (const l of ls) {
    for (const k of Object.keys(l)) {
      if (!lowerIds.has(k.toLowerCase())) continue;
      const v = l[k];
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      const s = String(v).trim();
      if (s && s.length <= 80 && !ids.includes(s)) ids.push(s);
    }
  }
  if (!ids.length) return null;

  const out: BusPosition = { ids: ids.slice(0, 12), lng, lat };
  for (const l of ls) {
    if (out.heading === undefined) {
      const h = num(pick(l, HEADING_KEYS));
      if (h !== undefined && h >= 0 && h <= 360) out.heading = h;
    }
    if (out.speed === undefined) {
      const s = num(pick(l, SPEED_KEYS));
      if (s !== undefined && s >= 0 && s < 400) out.speed = s;
    }
    if (out.ts === undefined) out.ts = toIso(pick(l, TIME_KEYS));
  }
  return out;
}

// Where is the list of vehicles? The payload itself, a well-known key, or —
// one level down — e.g. { response: { vehicles: [...] } }. A single vehicle
// object (typical for per-device webhooks) counts as a list of one.
function findList(payload: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!isObj(payload)) return null;
  const listKey = pick(payload, LIST_KEYS);
  if (Array.isArray(listKey)) return listKey;
  if (normalizeOne(payload)) return [payload];
  if (depth < 2) {
    for (const k of Object.keys(payload)) {
      const found = findList(payload[k], depth + 1);
      if (found && found.length) return found;
    }
  }
  return null;
}

export function normalizePositions(payload: unknown): BusPosition[] {
  const list = findList(payload) || [];
  const out: BusPosition[] = [];
  for (const item of list.slice(0, 2000)) {
    const p = normalizeOne(item);
    if (p) out.push(p);
  }
  return out;
}
