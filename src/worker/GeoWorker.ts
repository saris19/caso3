// Web Worker entry — loaded via new Worker(new URL('./GeoWorker.ts', import.meta.url), {type: 'module'})
// Route partitioning: workerIndex = fnv1a(routeId) % 4, each worker owns ~5-6 routes out of 22.
// Workers write state directly to SharedArrayBuffer; only lightweight events are posted back.
// NEVER use Atomics.wait here — lock-free versioned protocol only.

import type {
  Route, Stop, ScheduleEntry, GpsMessage, BusAssignment, BunchingAlert,
  RetentionRecommendation
} from '../core/types';
import { routeToSegments } from '../core/geo';
import { SpatialGrid } from '../core/SpatialGrid';
import { SequenceAssigner } from '../core/SequenceAssigner';
import { MonotonicTracker } from '../core/MonotonicTracker';
import { TravelTimeStore } from '../core/TravelTimeStore';
import { DynamicOrder } from '../core/DynamicOrder';
import { BunchingDetector } from '../core/BunchingDetector';
import { RetentionRecommender } from '../core/RetentionRecommender';

import {
  BUS_COUNT,
  SharedStateLayout,
  buildViews,
  beginWrite,
  endWrite,
  encodeRouteId,
  routeIdToWorkerIndex,
  writeBusRecord,
  writeAlertRing,
  writeRecRing,
  writeHistorySample,
} from './worker-shared';

const MSG_STRIDE = 48;

interface InitPayload {
  sab: SharedArrayBuffer;
  routes: Route[];
  stops: Stop[];
  schedule: ScheduleEntry[];
  workerIndex: number;
  routeIdIndicesForWorker: string[];
}

interface BatchPayload {
  payloadBuffer: ArrayBuffer;
  batchCount: number;
}

type WorkerMessage =
  | { type: 'INIT'; payload: InitPayload }
  | { type: 'GPS_BATCH'; payload: BatchPayload };

let sabRef: SharedArrayBuffer | null = null;
let workerIndex: number = -1;
let routes: Route[] = [];
let stops: Stop[] = [];
let schedule: ScheduleEntry[] = [];
let routeIndexMap: Map<string, number> = new Map();
let assignedRouteIds: Set<string> = new Set();

let routesById: Map<string, Route> = new Map();
let localGrid: SpatialGrid | null = null;
let sequenceAssigner: SequenceAssigner | null = null;
let monotonicTracker: MonotonicTracker | null = null;
let travelTimeStore: TravelTimeStore | null = null;
let dynamicOrder: DynamicOrder | null = null;
let bunchingDetector: BunchingDetector | null = null;
let globalDynamicOrder: DynamicOrder | null = null;
let retentionRecommender: RetentionRecommender | null = null;

let stopsByRoute: Map<string, Stop[]> = new Map();
let stopsById: Map<string, Stop> = new Map();
let scheduleByRoute: Map<string, ScheduleEntry[]> = new Map();
let routeTotalMeters: Map<string, number> = new Map();

let lastSegmentByBus: Map<number, { routeId: string; segmentIdx: number; tsMs: number; metersFromStart: number }> = new Map();
let alertRingSlot: number = 0;
let recRingSlot: number = 0;
let historySlotsByBus: Map<number, number> = new Map();
let stopsUsage: Map<string, Set<number>> = new Map();

const selfScope = self as unknown as DedicatedWorkerGlobalScope;

selfScope.onmessage = (ev: MessageEvent<WorkerMessage>) => {
  const msg = ev.data;
  if (!msg || !msg.type) return;
  if (msg.type === 'INIT') {
    handleInit(msg.payload);
  } else if (msg.type === 'GPS_BATCH') {
    handleBatch(msg.payload);
  }
};

function handleInit(payload: InitPayload): void {
  sabRef = payload.sab;
  workerIndex = payload.workerIndex;
  routes = payload.routes;
  stops = payload.stops;
  schedule = payload.schedule;
  assignedRouteIds = new Set(payload.routeIdIndicesForWorker);

  routeIndexMap = new Map();
  routes.forEach((r, i) => routeIndexMap.set(r.id, i));

  routesById = new Map();
  for (const r of routes) routesById.set(r.id, r);

  const assignedRoutes: Route[] = [];
  for (const id of assignedRouteIds) {
    const r = routesById.get(id);
    if (r) assignedRoutes.push(r);
  }

  const localSegments: ReturnType<typeof routeToSegments> = [];
  for (const r of assignedRoutes) {
    localSegments.push(...routeToSegments(r));
  }
  localGrid = new SpatialGrid(localSegments, 100);

  const assignedRoutesById = new Map<string, Route>();
  for (const r of assignedRoutes) assignedRoutesById.set(r.id, r);

  sequenceAssigner = new SequenceAssigner(assignedRoutesById, localGrid);
  monotonicTracker = new MonotonicTracker();
  travelTimeStore = new TravelTimeStore();
  dynamicOrder = new DynamicOrder(assignedRoutesById);

  stopsByRoute = new Map();
  stopsById = new Map();
  for (const s of stops) {
    stopsById.set(s.id, s);
    const arr = stopsByRoute.get(s.routeId) ?? [];
    arr.push(s);
    stopsByRoute.set(s.routeId, arr);
  }

  scheduleByRoute = new Map();
  for (const s of schedule) {
    const arr = scheduleByRoute.get(s.routeId) ?? [];
    arr.push(s);
    scheduleByRoute.set(s.routeId, arr);
  }

  routeTotalMeters = new Map();
  for (const r of routes) routeTotalMeters.set(r.id, r.totalMeters);

  const localScheduleByRoute = new Map<string, ScheduleEntry[]>();
  for (const id of assignedRouteIds) {
    const sch = scheduleByRoute.get(id);
    if (sch) localScheduleByRoute.set(id, sch);
  }
  bunchingDetector = new BunchingDetector(dynamicOrder, localScheduleByRoute, travelTimeStore);

  if (workerIndex === 0) {
    globalDynamicOrder = new DynamicOrder(routesById);
    retentionRecommender = new RetentionRecommender(stopsByRoute, routeTotalMeters);
  }

  postMessage({ type: 'INIT_OK', workerIndex });
}

function decodeBatch(buf: ArrayBuffer, count: number): GpsMessage[] {
  const dv = new DataView(buf);
  const result: GpsMessage[] = [];
  for (let i = 0; i < count; i++) {
    const base = i * MSG_STRIDE;
    const lon = dv.getFloat64(base, true);
    const lat = dv.getFloat64(base + 8, true);
    const vel = dv.getFloat32(base + 16, true);
    const rumbo = dv.getFloat32(base + 20, true);
    const ts = dv.getFloat64(base + 24, true);
    const bus = dv.getUint16(base + 32, true);
    const rutaIdx = dv.getUint8(base + 34);
    const hdop = dv.getFloat32(base + 36, true);
    const sats = dv.getUint8(base + 40);
    const ruta = (rutaIdx < routes.length && rutaIdx !== 0xff) ? routes[rutaIdx].id : '';
    result.push({ bus, ruta, lat, lon, vel, rumbo, ts, hdop, sats });
  }
  return result;
}

function handleBatch(payload: BatchPayload): void {
  if (!sabRef || !sequenceAssigner || !monotonicTracker || !dynamicOrder || !bunchingDetector) {
    postMessage({ type: 'ERROR', error: 'Worker not initialized' });
    return;
  }

  const messages = decodeBatch(payload.payloadBuffer, payload.batchCount);

  const localBusRecords: Array<{
    bus: number;
    routeIdIndex: number;
    status: number;
    estimatedFlag: number;
    metersFromStart: number;
    lat: number;
    lon: number;
    speed: number;
    heading: number;
  }> = [];

  const localHistoryWrites: Array<{
    bus: number;
    metersFromStart: number;
    lat: number;
    lon: number;
    serverTsMs: number;
  }> = [];

  let batchAlerts: BunchingAlert[] = [];

  for (const msg of messages) {
    let routeIdForHash = msg.ruta;
    if (!routeIdForHash) {
      const workerForUnknown = 0;
      if (workerIndex !== workerForUnknown) continue;
    } else {
      const targetWorker = routeIdToWorkerIndex(routeIdForHash, 4);
      if (targetWorker !== workerIndex) continue;
    }

    const assigned = sequenceAssigner.push(msg.bus, msg);
    if (!assigned) continue;

    const tracked = monotonicTracker.push(assigned);

    const routeIdIndex = encodeRouteId(tracked.routeId, routeIndexMap);
    const estimatedFlag = (tracked.estimated ? 1 : 0) | 2;
    localBusRecords.push({
      bus: tracked.bus,
      routeIdIndex,
      status: tracked.status,
      estimatedFlag,
      metersFromStart: tracked.metersFromStart,
      lat: tracked.lat,
      lon: tracked.lon,
      speed: tracked.speed,
      heading: tracked.heading,
    });

    localHistoryWrites.push({
      bus: tracked.bus,
      metersFromStart: tracked.metersFromStart,
      lat: tracked.lat,
      lon: tracked.lon,
      serverTsMs: tracked.serverTs,
    });

    const lastSeg = lastSegmentByBus.get(tracked.bus);
    if (lastSeg && lastSeg.routeId === tracked.routeId && lastSeg.segmentIdx !== tracked.segmentIdx) {
      if (travelTimeStore) {
        const deltaMs = tracked.serverTs - lastSeg.tsMs;
        if (deltaMs > 0) {
          const deltaMeters = tracked.metersFromStart - lastSeg.metersFromStart;
          const segCount = Math.abs(tracked.segmentIdx - lastSeg.segmentIdx);
          if (segCount > 0 && deltaMeters > 0) {
            const traversalSeconds = deltaMs / 1000 / segCount;
            for (let s = Math.min(lastSeg.segmentIdx, tracked.segmentIdx); s <= Math.max(lastSeg.segmentIdx, tracked.segmentIdx); s++) {
              travelTimeStore.onPassSegment(tracked.routeId, s, tracked.serverTs, traversalSeconds);
            }
          }
        }
      }
    }
    lastSegmentByBus.set(tracked.bus, {
      routeId: tracked.routeId,
      segmentIdx: tracked.segmentIdx,
      tsMs: tracked.serverTs,
      metersFromStart: tracked.metersFromStart,
    });

    dynamicOrder.upsert(tracked);
    if (globalDynamicOrder) {
      globalDynamicOrder.upsert(tracked);
    }
  }

  const batchRoutes = new Set<string>();
  for (const rec of localBusRecords) {
    const rid = routes[rec.routeIdIndex]?.id;
    if (rid) batchRoutes.add(rid);
  }
  for (const rid of batchRoutes) {
    const alerts = bunchingDetector.detect(rid, Date.now());
    batchAlerts.push(...alerts);
  }

  const localAlertWrites: Array<{
    routeIdIndex: number;
    busId: number;
    leaderBusId: number;
    projectedHeadwayRatio: number;
    projectedHeadwaySeconds: number;
    scheduledHeadwaySeconds: number;
    horizonSeconds: number;
    serverTs: number;
    severity: number;
  }> = [];
  for (const alert of batchAlerts) {
    const rIdx = routeIndexMap.get(alert.routeId) ?? 0xffff;
    localAlertWrites.push({
      routeIdIndex: rIdx,
      busId: alert.busId,
      leaderBusId: alert.leaderBusId,
      projectedHeadwayRatio: alert.projectedHeadwayRatio,
      projectedHeadwaySeconds: alert.projectedHeadwaySeconds,
      scheduledHeadwaySeconds: alert.scheduledHeadwaySeconds,
      horizonSeconds: alert.horizonSeconds,
      serverTs: alert.serverTs,
      severity: alert.severity === 'critical' ? 1 : 0,
    });
  }

  let localRecWrites: Array<{
    routeIdIndex: number;
    busId: number;
    minutes: number;
    resultingGapRatio: number;
    priority: number;
    stopId: string;
    stopSharedId?: string;
  }> = [];

  if (workerIndex === 0 && retentionRecommender && globalDynamicOrder) {
    const recs: RetentionRecommendation[] = retentionRecommender.recommend(
      batchAlerts,
      globalDynamicOrder,
      stopsById,
      stopsUsage,
      scheduleByRoute
    );
    for (const rec of recs) {
      const rIdx = routeIndexMap.get(rec.routeId) ?? 0xffff;
      localRecWrites.push({
        routeIdIndex: rIdx,
        busId: rec.busId,
        minutes: rec.minutes,
        resultingGapRatio: rec.resultingGapRatio,
        priority: rec.priority,
        stopId: rec.stopId,
        stopSharedId: rec.stopSharedId,
      });
    }
  }

  beginWrite(sabRef);
  const views = buildViews(sabRef);
  for (const rec of localBusRecords) {
    if (rec.bus >= 0 && rec.bus < BUS_COUNT) {
      writeBusRecord(views, rec.bus, rec);
    }
  }
  for (const hw of localHistoryWrites) {
    if (hw.bus >= 0 && hw.bus < BUS_COUNT) {
      const slot = historySlotsByBus.get(hw.bus) ?? 0;
      writeHistorySample(views.f32 as Float32Array, hw.bus, slot, hw);
      historySlotsByBus.set(hw.bus, (slot + 1) % SharedStateLayout.HISTORY_SAMPLES_PER_BUS);
    }
  }
  for (const aw of localAlertWrites) {
    writeAlertRing(views, alertRingSlot, aw);
    alertRingSlot = (alertRingSlot + 1) % SharedStateLayout.ALERT_RING_SIZE;
  }
  for (const rw of localRecWrites) {
    writeRecRing(views, recRingSlot, rw);
    recRingSlot = (recRingSlot + 1) % SharedStateLayout.REC_RING_SIZE;
  }
  endWrite(sabRef);

  if (batchAlerts.length > 0) {
    postMessage({ type: 'ALERTS', count: batchAlerts.length, workerIndex });
  }
  if (localRecWrites.length > 0) {
    postMessage({ type: 'RECS', count: localRecWrites.length, workerIndex });
  }
  postMessage({
    type: 'METRICS',
    workerIndex,
    processed: messages.length,
    committed: localBusRecords.length,
    alerts: batchAlerts.length,
    ts: Date.now(),
  });
}
