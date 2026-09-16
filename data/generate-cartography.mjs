import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname);

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const CENTER_LON = -77.28122;
const CENTER_LAT = 1.21384;
const EARTH_R = 6371008.8;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function projectXY(lon, lat) {
  const cosLat = Math.cos(CENTER_LAT * DEG2RAD);
  const x = (lon - CENTER_LON) * DEG2RAD * EARTH_R * cosLat;
  const y = (lat - CENTER_LAT) * DEG2RAD * EARTH_R;
  return [x, y];
}

function unprojectXY(x, y) {
  const cosLat = Math.cos(CENTER_LAT * DEG2RAD);
  const lon = CENTER_LON + (x / (EARTH_R * cosLat)) * RAD2DEG;
  const lat = CENTER_LAT + (y / EARTH_R) * RAD2DEG;
  return [lon, lat];
}

function haversine(a, b) {
  const dLat = (b[1] - a[1]) * DEG2RAD;
  const dLon = (b[0] - a[0]) * DEG2RAD;
  const lat1 = a[1] * DEG2RAD;
  const lat2 = b[1] * DEG2RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function cumulativeMeters(polyline) {
  const res = new Array(polyline.length).fill(0);
  for (let i = 1; i < polyline.length; i++) {
    res[i] = res[i - 1] + haversine(polyline[i - 1], polyline[i]);
  }
  return res;
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(42);
function randRange(min, max) { return min + rand() * (max - min); }
function randInt(min, max) { return Math.floor(randRange(min, max + 1)); }

function pickWeightedCapacity() {
  const r = rand();
  if (r < 0.35) return 1;
  if (r < 0.80) return 2;
  return 3;
}

function jitterPt(pt, metersMax) {
  const [x, y] = projectXY(pt[0], pt[1]);
  const angle = rand() * 2 * Math.PI;
  const r = rand() * metersMax;
  return unprojectXY(x + Math.cos(angle) * r, y + Math.sin(angle) * r);
}

function makeEWStreet(yLatMeters, lengthMeters, vertexSpacing) {
  const halfLen = lengthMeters / 2;
  const nPts = Math.max(2, Math.floor(lengthMeters / vertexSpacing) + 1);
  const pts = [];
  for (let i = 0; i <= nPts; i++) {
    const t = i / nPts;
    const x = -halfLen + t * 2 * halfLen;
    pts.push(unprojectXY(x, yLatMeters));
  }
  return pts;
}

const STREET_LEN = 2200;
const STREET_SPACING = 25;
const VERTEX_SPACING = 11;

const streetA = makeEWStreet(0, STREET_LEN, VERTEX_SPACING);
const streetB = makeEWStreet(STREET_SPACING, STREET_LEN, VERTEX_SPACING);

function buildApproachWest(streetY, extraLen) {
  const halfLen = STREET_LEN / 2;
  const startX = -halfLen - extraLen;
  const nPts = Math.max(10, Math.floor(extraLen / VERTEX_SPACING));
  const pts = [];
  for (let i = 0; i <= nPts; i++) {
    const t = i / nPts;
    const x = startX + t * extraLen;
    pts.push(jitterPt(unprojectXY(x, streetY), 0.5));
  }
  return pts;
}

function buildDepartureEast(streetY, extraLen) {
  const halfLen = STREET_LEN / 2;
  const endX = halfLen + extraLen;
  const nPts = Math.max(10, Math.floor(extraLen / VERTEX_SPACING));
  const pts = [];
  for (let i = 0; i <= nPts; i++) {
    const t = i / nPts;
    const x = halfLen + t * extraLen;
    pts.push(jitterPt(unprojectXY(x, streetY), 0.5));
  }
  return pts;
}

function buildConnector(fromXMeters, fromYMeters, toYMeters, offsetXMeters) {
  const startX = fromXMeters + offsetXMeters;
  const nPts = 25;
  const pts = [];
  for (let i = 0; i <= nPts; i++) {
    const t = i / nPts;
    const x = startX + t * 150;
    const y = fromYMeters + t * (toYMeters - fromYMeters);
    pts.push(jitterPt(unprojectXY(x, y), 0.3));
  }
  return pts;
}

function buildSpokePolyline(angleRad, lengthMeters, vertexCount) {
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  const perpX = Math.cos(angleRad + Math.PI / 2);
  const perpY = Math.sin(angleRad + Math.PI / 2);
  const pts = [];
  for (let i = 0; i < vertexCount; i++) {
    const t = i / (vertexCount - 1);
    const baseD = t * lengthMeters;
    const noise = (rand() - 0.5) * Math.min(25, baseD * 0.015);
    const x = cosA * baseD + perpX * noise;
    const y = sinA * baseD + perpY * noise;
    pts.push(unprojectXY(x, y));
  }
  return pts;
}

function addVerticesToReach(poly, targetMin, targetMax) {
  let result = [...poly];
  while (result.length < targetMin) {
    const next = [result[0]];
    for (let i = 1; i < result.length; i++) {
      const a = result[i - 1];
      const b = result[i];
      const mid = [
        (a[0] + b[0]) / 2 + (rand() - 0.5) * 5e-7,
        (a[1] + b[1]) / 2 + (rand() - 0.5) * 5e-7,
      ];
      next.push(mid, b);
    }
    result = next;
  }
  while (result.length > targetMax) {
    const next = [result[0]];
    for (let i = 1; i < result.length - 1; i += 2) {
      next.push(result[i + 1]);
    }
    if (next[next.length - 1] !== result[result.length - 1]) {
      next.push(result[result.length - 1]);
    }
    result = next;
  }
  return result;
}

const routeIds = Array.from({ length: 22 }, (_, i) => `R${String(i + 1).padStart(2, '0')}`);

const routesOnlyA = [0, 1, 2];
const routesBothAB = [3, 4, 5, 6, 7, 8];
const aRouteIdxs = [...routesOnlyA, ...routesBothAB];
const spokeRouteIdxs = Array.from({ length: 22 }, (_, i) => i).filter(i => !aRouteIdxs.includes(i));

const routes = [];
const intersectsStreetA = new Set();
const intersectsBothAB = new Set();

let routeNameCounter = 1;

for (const idx of routesOnlyA) {
  const rid = routeIds[idx];
  const wExtra = randRange(1800, 3600);
  const eExtra = randRange(1800, 3600);
  const approach = buildApproachWest(0, wExtra);
  const depart = buildDepartureEast(0, eExtra);
  const aJit = streetA.map(p => jitterPt(p, 0.5));
  const poly = [...approach.slice(0, -1), ...aJit, ...depart.slice(1)];
  const sized = addVerticesToReach(poly, 900, 2400);
  const cm = cumulativeMeters(sized);
  routes.push({
    id: rid,
    name: `Ruta ${routeNameCounter++} (A)`,
    polyline: sized,
    cumulativeMeters: cm,
    totalMeters: cm[cm.length - 1],
    parallelGroup: 'A',
  });
  intersectsStreetA.add(rid);
}

for (const idx of routesBothAB) {
  const rid = routeIds[idx];
  const wExtra = randRange(1500, 2800);
  const eExtra = randRange(1500, 2800);
  const connectX = randRange(-STREET_LEN * 0.25, STREET_LEN * 0.25);
  const approach = buildApproachWest(0, wExtra);
  const aJit = streetA.map(p => jitterPt(p, 0.5));
  const halfLen = STREET_LEN / 2;
  const aIdx = Math.max(1, Math.min(aJit.length - 2,
    Math.floor((connectX + halfLen) / STREET_LEN * (aJit.length - 1))));
  const aBefore = aJit.slice(0, aIdx + 1);
  const connStartX = -halfLen + (aIdx / (aJit.length - 1)) * STREET_LEN;
  const conn = buildConnector(connStartX, 0, STREET_SPACING, 20);
  const bEntryPoint = conn[conn.length - 1];
  const [bX] = projectXY(bEntryPoint[0], bEntryPoint[1]);
  const bJit = streetB.map(p => jitterPt(p, 0.5));
  let bStartIdx = 0;
  let minDx = Infinity;
  for (let i = 0; i < bJit.length; i++) {
    const [bx] = projectXY(bJit[i][0], bJit[i][1]);
    const dx = Math.abs(bx - bX);
    if (dx < minDx) { minDx = dx; bStartIdx = i; }
  }
  const bAfter = bJit.slice(Math.max(1, bStartIdx));
  const depart = buildDepartureEast(STREET_SPACING, eExtra);
  const poly = [
    ...approach.slice(0, -1),
    ...aBefore,
    ...conn.slice(1, -1),
    ...bAfter,
    ...depart.slice(1),
  ];
  const sized = addVerticesToReach(poly, 900, 2400);
  const cm = cumulativeMeters(sized);
  routes.push({
    id: rid,
    name: `Ruta ${routeNameCounter++} (A+B)`,
    polyline: sized,
    cumulativeMeters: cm,
    totalMeters: cm[cm.length - 1],
    parallelGroup: 'B',
  });
  intersectsStreetA.add(rid);
  intersectsBothAB.add(rid);
}

const spokeAngles = [
  Math.PI * 0.05, Math.PI * 0.25, Math.PI * 0.42,
  Math.PI * 0.58, Math.PI * 0.75, Math.PI * 0.95,
  Math.PI * 1.08, Math.PI * 1.25, Math.PI * 1.42,
  Math.PI * 1.58, Math.PI * 1.75, Math.PI * 1.95,
  Math.PI * 2.10, Math.PI * 2.30,
];

for (let k = 0; k < spokeRouteIdxs.length; k++) {
  const idx = spokeRouteIdxs[k];
  const rid = routeIds[idx];
  const angle = spokeAngles[k % spokeAngles.length] + (rand() - 0.5) * 0.05;
  const len = randRange(3800, 6200);
  const targetVerts = randInt(1100, 1800);
  const vertsHalf = Math.floor(targetVerts / 2);
  const outward = buildSpokePolyline(angle, len, vertsHalf);
  const returnAng = angle + Math.PI + (rand() - 0.5) * 0.06;
  const retLen = len + randRange(-200, 400);
  const retrace = buildSpokePolyline(returnAng, retLen, vertsHalf);
  const loopConn = [];
  const connSteps = 18;
  for (let i = 1; i <= connSteps; i++) {
    const t = i / (connSteps + 1);
    const a = outward[outward.length - 1];
    const b = retrace[0];
    loopConn.push([
      a[0] + (b[0] - a[0]) * t + (rand() - 0.5) * 0.0001,
      a[1] + (b[1] - a[1]) * t + (rand() - 0.5) * 0.0001,
    ]);
  }
  const retraceRev = retrace.slice().reverse();
  const poly = [...outward, ...loopConn, ...retraceRev.slice(1)];
  const sized = addVerticesToReach(poly, 900, 2400);
  const cm = cumulativeMeters(sized);
  routes.push({
    id: rid,
    name: `Ruta ${routeNameCounter++} (Radial)`,
    polyline: sized,
    cumulativeMeters: cm,
    totalMeters: cm[cm.length - 1],
    parallelGroup: null,
  });
}

routes.sort((a, b) => a.id.localeCompare(b.id));

const physicalStopKey = (pt) => {
  const [x, y] = projectXY(pt[0], pt[1]);
  const rx = Math.round(x / 25) * 25;
  const ry = Math.round(y / 25) * 25;
  return `${rx}_${ry}`;
};

const sharedStopIdByKey = new Map();
let sharedCounter = 0;
function nextSharedId() {
  sharedCounter++;
  return `SH${String(sharedCounter).padStart(4, '0')}`;
}

const allStops = [];
let stopCounter = 0;
for (const r of routes) {
  const cm = r.cumulativeMeters;
  const total = r.totalMeters;
  const interval = 450;
  let nextMeters = interval + randRange(-30, 30);
  let order = 0;
  while (nextMeters < total - 80) {
    let idx = 1;
    while (idx < cm.length && cm[idx] < nextMeters) idx++;
    if (idx >= cm.length) break;
    const denom = cm[idx] - cm[idx - 1];
    const t = denom > 1e-9 ? (nextMeters - cm[idx - 1]) / denom : 0;
    const a = r.polyline[idx - 1];
    const b = r.polyline[idx];
    const pos = [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
    ];
    stopCounter++;
    const sid = `S${String(stopCounter).padStart(5, '0')}`;
    const key = physicalStopKey(pos);
    let sharedStopId = undefined;
    if (r.parallelGroup) {
      if (sharedStopIdByKey.has(key)) {
        sharedStopId = sharedStopIdByKey.get(key);
      } else {
        sharedStopId = nextSharedId();
        sharedStopIdByKey.set(key, sharedStopId);
      }
    }
    allStops.push({
      id: sid,
      routeId: r.id,
      order: order++,
      metersFromStart: nextMeters,
      pos,
      capacity: pickWeightedCapacity(),
      sharedStopId,
    });
    nextMeters += interval + randRange(-50, 50);
  }
}

const hourBuckets = [
  { start: 6, end: 8, headway: 360 },
  { start: 8, end: 10, headway: 540 },
  { start: 10, end: 16, headway: 720 },
  { start: 16, end: 19, headway: 360 },
  { start: 19, end: 22, headway: 600 },
  { start: 22, end: 6, headway: 900 },
];

const schedule = [];
for (const r of routes) {
  for (const b of hourBuckets) {
    schedule.push({
      routeId: r.id,
      hourStart: b.start,
      hourEnd: b.end,
      headwaySeconds: b.headway,
    });
  }
}

writeFileSync(resolve(DATA_DIR, 'routes.json'), JSON.stringify(routes, null, 0));
writeFileSync(resolve(DATA_DIR, 'stops.json'), JSON.stringify(allStops, null, 0));
writeFileSync(resolve(DATA_DIR, 'schedule.json'), JSON.stringify(schedule, null, 0));

const totalVertices = routes.reduce((s, r) => s + r.polyline.length, 0);
const stopsPerRoute = new Map();
for (const s of allStops) {
  stopsPerRoute.set(s.routeId, (stopsPerRoute.get(s.routeId) || 0) + 1);
}
let sumStops = 0;
for (const c of stopsPerRoute.values()) sumStops += c;
const avgStops = sumStops / routes.length;

console.log('=== GENERATION REPORT ===');
console.log(`Routes generated: ${routes.length}`);
console.log(`Total vertices across all routes: ${totalVertices}`);
console.log(`Average stops per route: ${avgStops.toFixed(2)}`);
console.log(`Routes intersecting Street A: ${[...intersectsStreetA].sort().join(', ')} (total ${intersectsStreetA.size})`);
console.log(`Routes intersecting BOTH A and B: ${[...intersectsBothAB].sort().join(', ')} (total ${intersectsBothAB.size})`);
console.log('Route length stats (totalMeters):');
for (const r of routes) {
  console.log(`  ${r.id}: ${r.polyline.length} verts, ${r.totalMeters.toFixed(0)} m, stops=${stopsPerRoute.get(r.id) ?? 0}, pg=${r.parallelGroup ?? 'null'}`);
}
console.log(`Stops total: ${allStops.length}`);
console.log(`Schedule entries: ${schedule.length}`);
console.log(`Files written to: ${DATA_DIR}`);
