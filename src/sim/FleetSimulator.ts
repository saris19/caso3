import { mulberry32 } from './mulberry32.js';
import type { GpsMessage, Route, LonLat } from '../core/types.js';

export interface FleetStats {
  busCount: number;
  totalMessages: number;
  oooCount: number;
  oooPercent: number;
  avgHdopCenter: number;
  avgHdopOutside: number;
  avgNoiseCenter: number;
  avgNoiseOutside: number;
  silenceActiveCount: number;
  idleCount: number;
  idlePercent: number;
  reboundCount: number;
  perRouteSkewSample: [string, number][];
}

interface ForceBunchingEntry {
  routeId: string;
  busIndex: number;
  delaySeconds: number;
  remainingTicks: number;
}

interface OooBufferEntry {
  releaseTick: number;
  message: GpsMessage;
  isCenter: boolean;
  groundTruth: LonLat;
}

interface BusState {
  id: number;
  routeId: string;
  routeIdx: number;
  indexInRoute: number;
  metersFromStart: number;
  skewMs: number;
  silentUntilTick: number;
  nextSilenceAtTick: number;
  silenceDurationTicks: number;
  idle: boolean;
  idleToggleAtTick: number;
  hdopAccumCenter: number;
  hdopCountCenter: number;
  hdopAccumOutside: number;
  hdopCountOutside: number;
  noiseAccumCenter: number;
  noiseCountCenter: number;
  noiseAccumOutside: number;
  noiseCountOutside: number;
}

const CENTER_LON_MIN = -77.2825;
const CENTER_LON_MAX = -77.2800;
const CENTER_LAT_MIN = 1.2128;
const CENTER_LAT_MAX = 1.2149;
const BASE_SPEED = 5.5;
const PEAK_FACTOR = 0.65;
const MS_PER_HOUR = 3600 * 1000;
const SILENCE_LAMBDA_PER_TICK_TARGET = 1 / (15 * 60);
const IDLE_PERCENT_TARGET = 0.12;
const OOO_PROBABILITY = 0.03;
const REBOUND_LAT_OFFSET_METERS = 25;

function randInt(rand: () => number, min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

function gaussian(rand: () => number, mean: number, sigma: number): number {
  const u1 = Math.max(1e-9, rand());
  const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + sigma * z;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function isCenterBox(lon: number, lat: number): boolean {
  return lon >= CENTER_LON_MIN && lon <= CENTER_LON_MAX &&
    lat >= CENTER_LAT_MIN && lat <= CENTER_LAT_MAX;
}

function equirectangularMetersToDegrees(dxE: number, dyE: number, lat: number): [number, number] {
  const R = 6371000;
  const latRad = (lat * Math.PI) / 180;
  const dLat = (dyE / R) * (180 / Math.PI);
  const dLon = (dxE / (R * Math.cos(latRad))) * (180 / Math.PI);
  return [dLon, dLat];
}

function distanceEquirectangularMeters(a: LonLat, b: LonLat): number {
  const R = 6371000;
  const latRad = ((a[1] + b[1]) * 0.5 * Math.PI) / 180;
  const x = ((b[0] - a[0]) * Math.PI / 180) * R * Math.cos(latRad);
  const y = ((b[1] - a[1]) * Math.PI / 180) * R;
  return Math.sqrt(x * x + y * y);
}

function latOffsetMeters(lat: number, metersNorth: number): number {
  const R = 6371000;
  return lat + (metersNorth / R) * (180 / Math.PI);
}

function positionAtMeters(route: Route, meters: number): { pos: LonLat; heading: number } {
  const total = route.totalMeters;
  if (total <= 0) {
    return { pos: route.polyline[0] ?? [0, 0], heading: 0 };
  }
  let m = meters % total;
  if (m < 0) m += total;
  const cum = route.cumulativeMeters;
  const n = cum.length;
  let i = 0;
  for (let k = 1; k < n; k++) {
    if (cum[k] >= m) {
      i = k - 1;
      break;
    }
    if (k === n - 1) i = k - 1;
  }
  const segStart = cum[i];
  const segEnd = cum[Math.min(i + 1, n - 1)];
  const segLen = segEnd - segStart;
  const t = segLen > 0 ? clamp((m - segStart) / segLen, 0, 1) : 0;
  const a = route.polyline[i];
  const b = route.polyline[Math.min(i + 1, n - 1)];
  const lon = a[0] + (b[0] - a[0]) * t;
  const lat = a[1] + (b[1] - a[1]) * t;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let heading = (Math.atan2(dx, dy) * 180) / Math.PI;
  if (heading < 0) heading += 360;
  return { pos: [lon, lat], heading };
}

export class FleetSimulator {
  private routes: Route[];
  private rand: () => number;
  private speedFactor: number;
  private batchHertz: number;
  private tickMs: number;
  private serverTimeMs: number;
  private tick: number;
  private buses: BusState[];
  private busesPerRoute: Map<string, BusState[]>;
  private listeners: Array<(batch: GpsMessage[]) => void>;
  private intervalId: ReturnType<typeof setInterval> | null;
  private oooBuffer: OooBufferEntry[];
  private totalMessages: number;
  private oooCount: number;
  private reboundCount: number;
  private forceQueue: ForceBunchingEntry[];

  constructor(opts: {
    routes: Route[];
    seed: number;
    speedFactor?: number;
    batchHertz?: number;
  }) {
    this.routes = opts.routes;
    this.rand = mulberry32(opts.seed);
    this.speedFactor = opts.speedFactor ?? 1.0;
    this.batchHertz = opts.batchHertz ?? 10;
    this.tickMs = 1000 / this.batchHertz;
    this.serverTimeMs = Date.now();
    this.tick = 0;
    this.listeners = [];
    this.intervalId = null;
    this.oooBuffer = [];
    this.totalMessages = 0;
    this.oooCount = 0;
    this.reboundCount = 0;
    this.forceQueue = [];
    this.buses = [];
    this.busesPerRoute = new Map();

    const totalBuses = 310;
    const numRoutes = this.routes.length;
    const basePerRoute = Math.floor(totalBuses / numRoutes);
    const remainder = totalBuses - basePerRoute * numRoutes;

    let busGlobalId = 0;
    for (let r = 0; r < numRoutes; r++) {
      const route = this.routes[r];
      const count = basePerRoute + (r < remainder ? 1 : 0);
      const routeBuses: BusState[] = [];
      for (let b = 0; b < count; b++) {
        const metersFromStart = this.rand() * route.totalMeters;
        const skewMs = (this.rand() * 2 - 1) * 90e3;
        const silenceLambdaPerTick = SILENCE_LAMBDA_PER_TICK_TARGET / this.batchHertz;
        const ticksToSilence = this.geometricTicks(silenceLambdaPerTick);
        const bus: BusState = {
          id: busGlobalId,
          routeId: route.id,
          routeIdx: r,
          indexInRoute: b,
          metersFromStart,
          skewMs,
          silentUntilTick: 0,
          nextSilenceAtTick: this.tick + ticksToSilence,
          silenceDurationTicks: 0,
          idle: false,
          idleToggleAtTick: this.tick + randInt(this.rand, 6 * 60 * this.batchHertz, 10 * 60 * this.batchHertz),
          hdopAccumCenter: 0,
          hdopCountCenter: 0,
          hdopAccumOutside: 0,
          hdopCountOutside: 0,
          noiseAccumCenter: 0,
          noiseCountCenter: 0,
          noiseAccumOutside: 0,
          noiseCountOutside: 0,
        };
        bus.idle = this.determineInitialIdle(busGlobalId, totalBuses);
        this.buses.push(bus);
        routeBuses.push(bus);
        busGlobalId++;
      }
      this.busesPerRoute.set(route.id, routeBuses);
    }
  }

  private determineInitialIdle(busId: number, total: number): boolean {
    return (busId / total) < IDLE_PERCENT_TARGET;
  }

  private geometricTicks(lambda: number): number {
    const u = Math.max(1e-9, this.rand());
    return Math.max(1, Math.ceil(-Math.log(u) / lambda));
  }

  start(): void {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => {
      const batch = this.advanceTick();
      if (batch.length > 0) {
        for (const cb of this.listeners) cb(batch);
      }
    }, this.tickMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  onMessage(cb: (batch: GpsMessage[]) => void): void {
    this.listeners.push(cb);
  }

  forceBunching(routeId: string, busIndex: number, delaySeconds: number): void {
    this.forceQueue.push({
      routeId,
      busIndex,
      delaySeconds,
      remainingTicks: Math.ceil(delaySeconds * this.batchHertz),
    });
  }

  private advanceTick(): GpsMessage[] {
    this.tick++;
    this.serverTimeMs += this.tickMs;

    for (const f of this.forceQueue) {
      if (f.remainingTicks > 0) f.remainingTicks--;
    }

    const batchOut: GpsMessage[] = [];
    const releasedNow: OooBufferEntry[] = [];
    const stillBuffered: OooBufferEntry[] = [];
    for (const entry of this.oooBuffer) {
      if (entry.releaseTick <= this.tick) {
        releasedNow.push(entry);
      } else {
        stillBuffered.push(entry);
      }
    }
    this.oooBuffer = stillBuffered;

    const hourOfSim = ((this.serverTimeMs % MS_PER_HOUR) / MS_PER_HOUR) * 24;
    const isPeak = (hourOfSim >= 6 && hourOfSim < 9) || (hourOfSim >= 16 && hourOfSim < 19);
    const trafficFactor = 0.78 + 0.22 * Math.sin((hourOfSim / 24) * 2 * Math.PI);
    const peakMult = isPeak ? PEAK_FACTOR : 1.0;
    const baseSpeedTick = BASE_SPEED * this.speedFactor * trafficFactor * peakMult * (this.tickMs / 1000);

    for (let i = 0; i < this.buses.length; i++) {
      const bus = this.buses[i];

      if (this.tick >= bus.idleToggleAtTick) {
        bus.idle = !bus.idle;
        const idlePeriodTicks = randInt(
          this.rand,
          Math.round(6 * 60 * this.batchHertz),
          Math.round(10 * 60 * this.batchHertz),
        );
        const desiredIdleFrac = IDLE_PERCENT_TARGET;
        const periodTicks = Math.round(idlePeriodTicks / (bus.idle ? desiredIdleFrac : (1 - desiredIdleFrac)));
        bus.idleToggleAtTick = this.tick + Math.max(1, periodTicks);
      }

      const forceEntry = this.forceQueue.find(
        (f) => f.routeId === bus.routeId && f.busIndex === bus.indexInRoute && f.remainingTicks > 0,
      );
      if (!forceEntry) {
        bus.metersFromStart += baseSpeedTick + baseSpeedTick * 0.08 * (this.rand() * 2 - 1);
        if (bus.metersFromStart >= this.routes[bus.routeIdx].totalMeters) {
          bus.metersFromStart -= this.routes[bus.routeIdx].totalMeters;
        }
        if (bus.metersFromStart < 0) {
          bus.metersFromStart += this.routes[bus.routeIdx].totalMeters;
        }
      }

      if (this.tick >= bus.nextSilenceAtTick && bus.silentUntilTick < this.tick) {
        const minTicks = Math.round(40e3 / this.tickMs);
        const maxTicks = Math.round(240e3 / this.tickMs);
        bus.silenceDurationTicks = randInt(this.rand, minTicks, maxTicks);
        bus.silentUntilTick = this.tick + bus.silenceDurationTicks;
        const silenceLambdaPerTick = SILENCE_LAMBDA_PER_TICK_TARGET / this.batchHertz;
        bus.nextSilenceAtTick = bus.silentUntilTick + this.geometricTicks(silenceLambdaPerTick);
      }

      if (bus.silentUntilTick >= this.tick) {
        continue;
      }

      const route = this.routes[bus.routeIdx];
      const { pos: groundTruth, heading } = positionAtMeters(route, bus.metersFromStart);
      const gtlLon = groundTruth[0];
      const gtlLat = groundTruth[1];
      const inCenter = isCenterBox(gtlLon, gtlLat);

      let hdop: number;
      let sats: number;
      if (inCenter) {
        hdop = 2.0 + this.rand() * 4.0;
        sats = randInt(this.rand, 3, 8);
      } else {
        hdop = 1.0 + this.rand() * 1.5;
        sats = randInt(this.rand, 6, 10);
      }
      if (inCenter) {
        bus.hdopAccumCenter += hdop;
        bus.hdopCountCenter++;
      } else {
        bus.hdopAccumOutside += hdop;
        bus.hdopCountOutside++;
      }

      const sigma = clamp(6 + (hdop - 1) * 2.2, 6, 18);
      let noisyLon = gtlLon;
      let noisyLat = gtlLat;
      let reboundApplied = false;

      if (inCenter) {
        const pRebound = clamp((hdop - 1.5) * 0.12, 0.05, 0.55);
        if (this.rand() < pRebound) {
          reboundApplied = true;
          this.reboundCount++;
          const sign = this.rand() < 0.5 ? 1 : -1;
          const newLat = latOffsetMeters(gtlLat, sign * REBOUND_LAT_OFFSET_METERS);
          const extraDx = gaussian(this.rand, 0, 60);
          const extraDy = gaussian(this.rand, 0, 60);
          const [dLon, dLat] = equirectangularMetersToDegrees(extraDx, extraDy, newLat);
          noisyLon = gtlLon + dLon;
          noisyLat = newLat + dLat;
        } else {
          const dx = gaussian(this.rand, 0, sigma);
          const dy = gaussian(this.rand, 0, sigma);
          const [dLon, dLat] = equirectangularMetersToDegrees(dx, dy, gtlLat);
          noisyLon = gtlLon + dLon;
          noisyLat = gtlLat + dLat;
        }
      } else {
        const dx = gaussian(this.rand, 0, sigma);
        const dy = gaussian(this.rand, 0, sigma);
        const [dLon, dLat] = equirectangularMetersToDegrees(dx, dy, gtlLat);
        noisyLon = gtlLon + dLon;
        noisyLat = gtlLat + dLat;
      }

      const noiseDist = distanceEquirectangularMeters(groundTruth, [noisyLon, noisyLat]);
      if (inCenter) {
        bus.noiseAccumCenter += noiseDist;
        bus.noiseCountCenter++;
      } else {
        bus.noiseAccumOutside += noiseDist;
        bus.noiseCountOutside++;
      }

      const speedMs = BASE_SPEED * this.speedFactor * trafficFactor * peakMult * (0.9 + 0.2 * this.rand());

      const msg: GpsMessage = {
        bus: bus.id,
        ruta: bus.routeId,
        lat: noisyLat,
        lon: noisyLon,
        vel: speedMs,
        rumbo: heading,
        ts: Math.round(this.serverTimeMs + bus.skewMs),
        hdop: Number(hdop.toFixed(3)),
        sats,
      };

      const useOoo = this.rand() < OOO_PROBABILITY;
      if (useOoo) {
        const delayTicks = randInt(this.rand, 1, 5);
        this.oooBuffer.push({
          releaseTick: this.tick + delayTicks,
          message: msg,
          isCenter: inCenter,
          groundTruth,
        });
        this.oooCount++;
      } else {
        batchOut.push(msg);
      }
      this.totalMessages++;
    }

    for (const entry of releasedNow) {
      batchOut.push(entry.message);
    }

    return batchOut;
  }

  getStats(): FleetStats {
    let hdopCSum = 0, hdopCCnt = 0;
    let hdopOSum = 0, hdopOCnt = 0;
    let noiseCSum = 0, noiseCCnt = 0;
    let noiseOSum = 0, noiseOCnt = 0;
    let silenceCount = 0;
    let idleCount = 0;
    for (const bus of this.buses) {
      hdopCSum += bus.hdopAccumCenter;
      hdopCCnt += bus.hdopCountCenter;
      hdopOSum += bus.hdopAccumOutside;
      hdopOCnt += bus.hdopCountOutside;
      noiseCSum += bus.noiseAccumCenter;
      noiseCCnt += bus.noiseCountCenter;
      noiseOSum += bus.noiseAccumOutside;
      noiseOCnt += bus.noiseCountOutside;
      if (bus.silentUntilTick >= this.tick) silenceCount++;
      if (bus.idle) idleCount++;
    }
    const perRouteSkewSample: [string, number][] = [];
    for (const route of this.routes) {
      const list = this.busesPerRoute.get(route.id);
      if (list && list.length > 0) {
        const sample = list[0];
        perRouteSkewSample.push([route.id, sample.skewMs]);
      }
    }
    return {
      busCount: this.buses.length,
      totalMessages: this.totalMessages,
      oooCount: this.oooCount,
      oooPercent: this.totalMessages > 0 ? (this.oooCount / this.totalMessages) * 100 : 0,
      avgHdopCenter: hdopCCnt > 0 ? hdopCSum / hdopCCnt : 0,
      avgHdopOutside: hdopOCnt > 0 ? hdopOSum / hdopOCnt : 0,
      avgNoiseCenter: noiseCCnt > 0 ? noiseCSum / noiseCCnt : 0,
      avgNoiseOutside: noiseOCnt > 0 ? noiseOSum / noiseOCnt : 0,
      silenceActiveCount: silenceCount,
      idleCount,
      idlePercent: (idleCount / this.buses.length) * 100,
      reboundCount: this.reboundCount,
      perRouteSkewSample,
    };
  }

  async checksumFromTicks(
    ticks: number,
    forceScenario?: { routeId: string; busIndex: number; delaySeconds: number }[],
  ): Promise<string> {
    const savedTick = this.tick;
    const savedServerTime = this.serverTimeMs;
    const savedBuses = this.buses.map((b) => ({ ...b }));
    const savedOoo = this.oooBuffer.map((e) => ({ ...e, message: { ...e.message }, groundTruth: [...e.groundTruth] as LonLat }));
    const savedForceQueue = this.forceQueue.map((f) => ({ ...f }));
    const savedTotal = this.totalMessages;
    const savedOooCount = this.oooCount;
    const savedRebound = this.reboundCount;

    const lines: string[] = [];
    if (forceScenario) {
      for (const sc of forceScenario) {
        this.forceBunching(sc.routeId, sc.busIndex, sc.delaySeconds);
      }
    }
    for (let i = 0; i < ticks; i++) {
      const batch = this.advanceTick();
      for (const msg of batch) {
        lines.push(JSON.stringify(msg));
      }
    }
    const combined = lines.join('\n');
    let hash: string;
    if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
      const enc = new TextEncoder();
      const buf = enc.encode(combined);
      const digest = await crypto.subtle.digest('SHA-256', buf);
      hash = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } else {
      const nodeCrypto = await import('node:crypto');
      hash = nodeCrypto.createHash('sha256').update(combined, 'utf8').digest('hex');
    }

    this.tick = savedTick;
    this.serverTimeMs = savedServerTime;
    for (let i = 0; i < this.buses.length; i++) {
      Object.assign(this.buses[i], savedBuses[i]);
    }
    this.oooBuffer = savedOoo;
    this.forceQueue = savedForceQueue;
    this.totalMessages = savedTotal;
    this.oooCount = savedOooCount;
    this.reboundCount = savedRebound;

    return hash;
  }
}
