// Shared type contracts used across main thread, workers, simulator and service worker.
// KEEP THIS FILE AGNOSTIC TO ANY PARTICULAR MODULE — no imports from /render, /sim, /worker, /ui or /sw.

export type LonLat = [number, number]; // [lon, lat] — math order

export interface Route {
  id: string;        // e.g. "R01"
  name: string;
  polyline: LonLat[];
  cumulativeMeters: number[]; // cumulativeMeters[i] = distance along route from start to vertex i
  totalMeters: number;
  parallelGroup?: 'A' | 'B' | null; // marks the parallel-street pair in the center
}

export interface Segment {
  routeId: string;
  index: number;      // segment index within route polyline
  a: LonLat;
  b: LonLat;
  startMeters: number;
  lengthMeters: number;
}

export interface Stop {
  id: string;
  routeId: string;
  order: number;           // 0-based order along the route
  metersFromStart: number;
  pos: LonLat;
  capacity: 1 | 2 | 3;     // physical simultaneous buses
  sharedStopId?: string;   // non-empty when several routes share the physical stop
}

export interface ScheduleEntry {
  routeId: string;
  hourStart: number;   // 0..23
  hourEnd: number;
  headwaySeconds: number; // programmed interval
}

export interface GpsMessage {
  bus: number;           // 0..309
  ruta: string;          // route id reported by the bus (may be stale for a few frames)
  lat: number;
  lon: number;
  vel: number;           // m/s
  rumbo: number;         // degrees 0..360
  ts: number;            // bus-device timestamp (ms, may be up to ±90s skewed)
  hdop: number;          // >=1.0; larger = less precise
  sats: number;          // satellites
}

export type BusStatus = 0 | 1 | 2; // 0=idle/off-service, 1=running, 2=retained-at-stop

export interface BusAssignment {
  bus: number;
  routeId: string;
  segmentIdx: number;
  segmentT: number;      // 0..1 along segment
  metersFromStart: number;
  distanceToSegment: number;
  estimated: boolean;    // true if position was interpolated during silence
  status: BusStatus;
  serverTs: number;      // server-time (ms) when this record was produced
  speed: number;
  heading: number;
  lat: number;
  lon: number;
}

export interface SegmentCandidate {
  seg: Segment;
  distance: number;
  t: number;             // 0..1 projection
  metersFromStart: number;
}

export interface BunchingAlert {
  id: string;
  routeId: string;
  busId: number;
  leaderBusId: number;
  projectedHeadwayRatio: number;   // projectedHeadway / scheduledHeadway  (<0.4 = bunching)
  projectedHeadwaySeconds: number;
  scheduledHeadwaySeconds: number;
  horizonSeconds: number;          // how far ahead (<= now + horizonSeconds)
  serverTs: number;
  severity: 'warning' | 'critical';
}

export interface RetentionRecommendation {
  id: string;
  busId: number;
  routeId: string;
  stopId: string;
  stopSharedId?: string;
  minutes: number;
  resultingGapRatio: number;       // the gap *behind* this bus after retention / scheduled (must be <= 1.6)
  priority: number;                // larger = more urgent; for tie-break in shared stops
  reason: string;
}

export interface ActionRecord {
  id: string;
  type: 'retain' | 'idle' | 'incident';
  busId?: number;
  stopId?: string;
  minutes?: number;
  note?: string;
  createdAt: number;
  synced: boolean;
  syncAt?: number;
}

export interface MetricsSample {
  ts: number;
  ipiMs: number;
  inputMs: number;
  processingMs: number;
  presentationMs: number;
  longTaskMs: number;
  fps: number;
}
