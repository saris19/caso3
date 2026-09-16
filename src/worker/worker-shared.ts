import type { Route } from '../core/types';

export const BUS_COUNT = 310;
export const ALERT_RING_SIZE = 64;
export const REC_RING_SIZE = 32;
export const HISTORY_SAMPLES_PER_BUS = 480;

export const HEADER_SIZE = 16;
export const BUS_RECORD_SIZE = 32;
export const ALERT_SIZE = 48;
export const REC_SIZE = 64;
export const HISTORY_SAMPLE_SIZE = 16;

export const OFFSET_HEADER_VERSION_START = 0;
export const OFFSET_HEADER_VERSION_END = 4;
export const OFFSET_HEADER_BUS_COUNT = 8;
export const OFFSET_HEADER_TEAR_COUNTER = 12;

export const OFFSET_BUS_RECORDS = HEADER_SIZE;
export const OFFSET_ALERTS = OFFSET_BUS_RECORDS + BUS_RECORD_SIZE * BUS_COUNT;
export const OFFSET_RECS = OFFSET_ALERTS + ALERT_SIZE * ALERT_RING_SIZE;
export const OFFSET_HISTORY = OFFSET_RECS + REC_SIZE * REC_RING_SIZE;

const RAW_SAB_BYTES = OFFSET_HISTORY + BUS_COUNT * HISTORY_SAMPLES_PER_BUS * HISTORY_SAMPLE_SIZE;
export const SAB_BYTES = Math.ceil(RAW_SAB_BYTES / 64) * 64;

export class SharedStateLayout {
  static get HEADER_VERSION_START(): number { return OFFSET_HEADER_VERSION_START; }
  static get HEADER_VERSION_END(): number { return OFFSET_HEADER_VERSION_END; }
  static get HEADER_BUS_COUNT(): number { return OFFSET_HEADER_BUS_COUNT; }
  static get HEADER_TEAR_COUNTER(): number { return OFFSET_HEADER_TEAR_COUNTER; }

  static get BUS_RECORDS_START(): number { return OFFSET_BUS_RECORDS; }
  static get BUS_RECORD_SIZE(): number { return BUS_RECORD_SIZE; }
  static get BUS_RECORD_ROUTE_IDX(): number { return 0; }
  static get BUS_RECORD_STATUS(): number { return 2; }
  static get BUS_RECORD_ESTIMATED_FLAG(): number { return 3; }
  static get BUS_RECORD_METERS(): number { return 4; }
  static get BUS_RECORD_LAT(): number { return 8; }
  static get BUS_RECORD_LON(): number { return 16; }
  static get BUS_RECORD_SPEED(): number { return 24; }
  static get BUS_RECORD_HEADING(): number { return 28; }
  static get BUS_RECORD_RESERVED(): number { return 30; }

  static get ALERTS_START(): number { return OFFSET_ALERTS; }
  static get ALERT_SIZE(): number { return ALERT_SIZE; }
  static get ALERT_RING_SIZE(): number { return ALERT_RING_SIZE; }
  static get ALERT_ROUTE_IDX(): number { return 0; }
  static get ALERT_BUS_ID(): number { return 2; }
  static get ALERT_LEADER_BUS_ID(): number { return 6; }
  static get ALERT_PROJECTED_RATIO(): number { return 10; }
  static get ALERT_PROJECTED_SECONDS(): number { return 14; }
  static get ALERT_SCHEDULED_SECONDS(): number { return 18; }
  static get ALERT_HORIZON_SECONDS(): number { return 22; }
  static get ALERT_SERVER_TS(): number { return 26; }
  static get ALERT_SEVERITY(): number { return 34; }

  static get RECS_START(): number { return OFFSET_RECS; }
  static get REC_SIZE(): number { return REC_SIZE; }
  static get REC_RING_SIZE(): number { return REC_RING_SIZE; }
  static get REC_ROUTE_IDX(): number { return 0; }
  static get REC_BUS_ID(): number { return 2; }
  static get REC_MINUTES(): number { return 6; }
  static get REC_GAP_RATIO(): number { return 10; }
  static get REC_PRIORITY(): number { return 14; }
  static get REC_STOP_ID(): number { return 18; }
  static get REC_STOP_SHARED_ID(): number { return 36; }

  static get HISTORY_START(): number { return OFFSET_HISTORY; }
  static get HISTORY_SAMPLE_SIZE(): number { return HISTORY_SAMPLE_SIZE; }
  static get HISTORY_SAMPLES_PER_BUS(): number { return HISTORY_SAMPLES_PER_BUS; }
  static get HISTORY_METERS(): number { return 0; }
  static get HISTORY_LAT(): number { return 4; }
  static get HISTORY_LON(): number { return 8; }
  static get HISTORY_TS(): number { return 12; }

  static get TOTAL_BYTES(): number { return SAB_BYTES; }
}

export function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function routeIdToWorkerIndex(routeId: string, workerCount: number = 4): number {
  return fnv1a(routeId) % workerCount;
}

export function buildRouteIndexMap(routes: Route[]): Map<string, number> {
  const map = new Map<string, number>();
  routes.forEach((r, i) => map.set(r.id, i));
  return map;
}

export function encodeRouteId(routeId: string, routeIndexMap: Map<string, number>): number {
  const idx = routeIndexMap.get(routeId);
  return idx !== undefined ? idx : 0xffff;
}

export function decodeRouteIndex(index: number, routes: Route[]): string | null {
  if (index === 0xffff || index < 0 || index >= routes.length) return null;
  return routes[index].id;
}

export function buildViews(sab: SharedArrayBuffer): {
  u32: Uint32Array;
  u16: Uint16Array;
  u8: Uint8Array;
  f32: Float32Array;
  f64: Float64Array;
} {
  return {
    u32: new Uint32Array(sab),
    u16: new Uint16Array(sab),
    u8: new Uint8Array(sab),
    f32: new Float32Array(sab),
    f64: new Float64Array(sab),
  };
}

export function beginWrite(sab: SharedArrayBuffer): void {
  const u32 = new Uint32Array(sab);
  Atomics.add(u32, OFFSET_HEADER_VERSION_START >>> 2, 1);
}

export function endWrite(sab: SharedArrayBuffer): void {
  const u32 = new Uint32Array(sab);
  Atomics.add(u32, OFFSET_HEADER_VERSION_START >>> 2, 1);
  const version = Atomics.load(u32, OFFSET_HEADER_VERSION_START >>> 2);
  Atomics.store(u32, OFFSET_HEADER_VERSION_END >>> 2, version);
}

export function readConsistent<T>(
  sab: SharedArrayBuffer,
  fn: (views: {
    u32: Uint32Array;
    u16: Uint16Array;
    u8: Uint8Array;
    f32: Float32Array;
    f64: Float64Array;
  }) => T,
  maxRetries: number = 3
): T | null {
  const u32 = new Uint32Array(sab);
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const start = Atomics.load(u32, OFFSET_HEADER_VERSION_START >>> 2);
    if (start % 2 === 1) continue;
    const views = buildViews(sab);
    const result = fn(views);
    const end = Atomics.load(u32, OFFSET_HEADER_VERSION_END >>> 2);
    if (start === end && start % 2 === 0) {
      return result;
    }
  }
  Atomics.add(u32, OFFSET_HEADER_TEAR_COUNTER >>> 2, 1);
  return null;
}

export function writeBusRecord(
  views: { u16: Uint16Array; u8: Uint8Array; f32: Float32Array; f64: Float64Array },
  busIndex: number,
  data: {
    routeIdIndex: number;
    status: number;
    estimatedFlag: number;
    metersFromStart: number;
    lat: number;
    lon: number;
    speed: number;
    heading: number;
  }
): void {
  const base = OFFSET_BUS_RECORDS + busIndex * BUS_RECORD_SIZE;
  const u16Off = base >>> 1;
  const u8Off = base;
  const f32Off = base >>> 2;
  const f64Off = base >>> 3;

  views.u16[u16Off + 0] = data.routeIdIndex;
  views.u8[u8Off + 2] = data.status;
  views.u8[u8Off + 3] = data.estimatedFlag;
  views.f32[f32Off + 1] = data.metersFromStart;
  views.f64[f64Off + 1] = data.lat;
  views.f64[f64Off + 2] = data.lon;
  views.f32[f32Off + 6] = data.speed;
  views.u16[u16Off + 14] = Math.min(65535, Math.max(0, Math.round(data.heading * 182.044)));
}

export function writeAlertRing(
  views: { u16: Uint16Array; u8: Uint8Array; f32: Float32Array; f64: Float64Array },
  slot: number,
  data: {
    routeIdIndex: number;
    busId: number;
    leaderBusId: number;
    projectedHeadwayRatio: number;
    projectedHeadwaySeconds: number;
    scheduledHeadwaySeconds: number;
    horizonSeconds: number;
    serverTs: number;
    severity: number;
  }
): void {
  const s = slot % ALERT_RING_SIZE;
  const base = OFFSET_ALERTS + s * ALERT_SIZE;
  const u16Off = base >>> 1;
  const u32Off = base >>> 2;
  const f32Off = base >>> 2;
  const f64Off = base >>> 3;
  const u8Off = base;

  views.u16[u16Off + 0] = data.routeIdIndex;
  views.u32[u32Off + 1] = data.busId;
  views.u32[u32Off + 2] = data.leaderBusId;
  views.f32[f32Off + 4] = data.projectedHeadwayRatio;
  views.f32[f32Off + 5] = data.projectedHeadwaySeconds;
  views.f32[f32Off + 6] = data.scheduledHeadwaySeconds;
  views.f32[f32Off + 7] = data.horizonSeconds;
  views.f64[f64Off + 4] = data.serverTs;
  views.u8[u8Off + 34] = data.severity;
}

export function writeRecRing(
  views: { u16: Uint16Array; u8: Uint8Array; f32: Float32Array },
  slot: number,
  data: {
    routeIdIndex: number;
    busId: number;
    minutes: number;
    resultingGapRatio: number;
    priority: number;
    stopId: string;
    stopSharedId?: string;
  }
): void {
  const s = slot % REC_RING_SIZE;
  const base = OFFSET_RECS + s * REC_SIZE;
  const u16Off = base >>> 1;
  const u32Off = base >>> 2;
  const f32Off = base >>> 2;
  const u8Off = base;

  views.u16[u16Off + 0] = data.routeIdIndex;
  views.u32[u32Off + 1] = data.busId;
  views.f32[f32Off + 3] = data.minutes;
  views.f32[f32Off + 4] = data.resultingGapRatio;
  views.f32[f32Off + 5] = data.priority;

  for (let i = 0; i < 18 && i < data.stopId.length; i++) {
    views.u8[u8Off + 18 + i] = data.stopId.charCodeAt(i);
  }
  if (data.stopSharedId) {
    for (let i = 0; i < 18 && i < data.stopSharedId.length; i++) {
      views.u8[u8Off + 36 + i] = data.stopSharedId.charCodeAt(i);
    }
  }
}

export function writeHistorySample(
  views: { f32: Float32Array },
  busIndex: number,
  sampleSlot: number,
  data: {
    metersFromStart: number;
    lat: number;
    lon: number;
    serverTsMs: number;
  }
): void {
  const sample = sampleSlot % HISTORY_SAMPLES_PER_BUS;
  const base = OFFSET_HISTORY + (busIndex * HISTORY_SAMPLES_PER_BUS + sample) * HISTORY_SAMPLE_SIZE;
  const f32Off = base >>> 2;
  views.f32[f32Off + 0] = data.metersFromStart;
  views.f32[f32Off + 1] = data.lat;
  views.f32[f32Off + 2] = data.lon;
  views.f32[f32Off + 3] = data.serverTsMs / 1000;
}
