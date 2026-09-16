import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname);

const CENTER_LON = -77.28122;
const CENTER_LAT = 1.21384;
const EARTH_R = 6371008.8;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const STREET_LEN = 2200;
const STREET_SPACING = 25;
const SAMPLE_EVERY = 5;
const FLIP_PROB = 0.30;
const SIGMA_NORMAL = 10;
const SIGMA_FLIPPED = 15;
const VERTEX_SPACING = 11;

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

function mulberry32(a) {
  return function () {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(12345);

function gaussRandom(mean = 0, sigma = 1) {
  let u1 = 0, u2 = 0;
  while (u1 === 0) u1 = rand();
  while (u2 === 0) u2 = rand();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + sigma * z;
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

function cumulativeMeters(polyline) {
  const res = new Array(polyline.length).fill(0);
  for (let i = 1; i < polyline.length; i++) {
    res[i] = res[i - 1] + haversine(polyline[i - 1], polyline[i]);
  }
  return res;
}

function sampleAlongPolyline(polyline, cumMeters, targetMeters) {
  if (targetMeters <= 0) return { lon: polyline[0][0], lat: polyline[0][1], segIdx: 0, t: 0 };
  const total = cumMeters[cumMeters.length - 1];
  if (targetMeters >= total) {
    const last = polyline[polyline.length - 1];
    return { lon: last[0], lat: last[1], segIdx: polyline.length - 2, t: 1 };
  }
  let idx = 1;
  while (idx < cumMeters.length && cumMeters[idx] < targetMeters) idx++;
  const segStart = cumMeters[idx - 1];
  const segLen = cumMeters[idx] - segStart;
  const t = segLen > 1e-9 ? (targetMeters - segStart) / segLen : 0;
  const a = polyline[idx - 1];
  const b = polyline[idx];
  return {
    lon: a[0] + (b[0] - a[0]) * t,
    lat: a[1] + (b[1] - a[1]) * t,
    segIdx: idx - 1,
    t,
  };
}

const routes = JSON.parse(readFileSync(resolve(DATA_DIR, 'routes.json'), 'utf-8'));
const r01 = routes.find(r => r.id === 'R01');
if (!r01) {
  console.error('ERROR: R01 not found in routes.json');
  process.exit(1);
}

const streetAPure = makeEWStreet(0, STREET_LEN, VERTEX_SPACING);
const streetACM = cumulativeMeters(streetAPure);
const totalMetersA = streetACM[streetACM.length - 1];

console.log(`Street A pure length: ${totalMetersA.toFixed(1)} m`);
console.log(`Sampling every ${SAMPLE_EVERY} m → ~${Math.floor(totalMetersA / SAMPLE_EVERY)} points`);

const points = [];
let flippedCount = 0;

for (let m = 0; m <= totalMeters; m += SAMPLE_EVERY) {
  const gt = sampleAlongPolyline(streetAPure, streetACM, m);
  const [gx, gy] = projectXY(gt.lon, gt.lat);
  const flipped = rand() < FLIP_PROB;
  let dxMeters = 0;
  let dyMeters = 0;
  if (flipped) {
    flippedCount++;
    dyMeters += STREET_SPACING;
    dxMeters = gaussRandom(0, SIGMA_FLIPPED);
    dyMeters += gaussRandom(0, SIGMA_FLIPPED);
  } else {
    dxMeters = gaussRandom(0, SIGMA_NORMAL);
    dyMeters = gaussRandom(0, SIGMA_NORMAL);
  }
  const [gpsLon, gpsLat] = unprojectXY(gx + dxMeters, gy + dyMeters);
  points.push({
    gtLon: gt.lon,
    gtLat: gt.lat,
    gpsLon,
    gpsLat,
    trueRouteId: 'R01',
    trueStreet: 'A',
    trueMetersFromStart: m,
    flipped,
  });
}

const output = {
  description: 'Walk along Street A (R01) sampled every 5 m with 30% parallel-flip noise + 10–15 m jitter. Ground truth is always R01 (A).',
  points,
};

const outPath = resolve(DATA_DIR, 'labeled_trajectory.json');
const jsonStr = JSON.stringify(output, null, 0);
writeFileSync(outPath, jsonStr);

const sizeBytes = Buffer.byteLength(jsonStr, 'utf-8');

console.log('\n=== LABELED TRAJECTORY GENERATION REPORT ===');
console.log(`Total ground-truth points: ${points.length}`);
console.log(`Flipped (mirrored to B) count: ${flippedCount} (${((flippedCount / points.length) * 100).toFixed(1)}%)`);
console.log(`Non-flipped count: ${points.length - flippedCount}`);
console.log(`Total meters walked: ${totalMetersA.toFixed(0)} m`);
console.log(`JSON file size: ${sizeBytes} bytes`);
console.log(`File written to: ${outPath}`);
console.log(`\nFirst point sample:`);
console.log(`  gt=(${points[0].gtLon.toFixed(6)}, ${points[0].gtLat.toFixed(6)})`);
console.log(`  gps=(${points[0].gpsLon.toFixed(6)}, ${points[0].gpsLat.toFixed(6)}) flipped=${points[0].flipped} m=${points[0].trueMetersFromStart}`);
console.log(`Mid point sample (idx ${Math.floor(points.length / 2)}):`);
const mid = points[Math.floor(points.length / 2)];
console.log(`  gt=(${mid.gtLon.toFixed(6)}, ${mid.gtLat.toFixed(6)}) m=${mid.trueMetersFromStart.toFixed(0)}`);
console.log(`  gps=(${mid.gpsLon.toFixed(6)}, ${mid.gpsLat.toFixed(6)}) flipped=${mid.flipped}`);
