import type { GpsMessage, Route, Segment, SegmentCandidate } from './types';
import type { LabeledPoint, ValidationReport } from './labeled-types';
import { SpatialGrid } from './SpatialGrid';
import { SequenceAssigner } from './SequenceAssigner';
import { haversineDistance, projectPointToPolyline, routeToSegments } from './geo';

const A_ROUTES = new Set(['R01', 'R02', 'R03']);
const PARALLEL_ROUTES = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09'];

function isARoute(routeId: string): boolean {
  return A_ROUTES.has(routeId);
}

function countFalseSwitches(assignedRouteIds: string[]): number {
  if (assignedRouteIds.length < 2) return 0;
  let crossTransitions = 0;
  let prev = assignedRouteIds[0];
  for (let i = 1; i < assignedRouteIds.length; i++) {
    const curr = assignedRouteIds[i];
    const prevA = isARoute(prev);
    const currA = isARoute(curr);
    if (prevA !== currA) {
      crossTransitions++;
    }
    prev = curr;
  }
  return Math.ceil(crossTransitions / 2);
}

export class TrajectoryValidator {
  private routesById: Map<string, Route>;
  private parallelSegments: Segment[];
  private parallelGrid: SpatialGrid;
  private parallelRoutesById: Map<string, Route>;

  constructor(routesById: Map<string, Route>) {
    this.routesById = routesById;
    this.parallelRoutesById = new Map();
    this.parallelSegments = [];
    for (const rid of PARALLEL_ROUTES) {
      const r = routesById.get(rid);
      if (!r) continue;
      this.parallelRoutesById.set(rid, r);
      this.parallelSegments.push(...routeToSegments(r));
    }
    this.parallelGrid = new SpatialGrid(this.parallelSegments, 100);
  }

  static baselineNearest(
    routesById: Map<string, Route>,
    grid: SpatialGrid,
    points: LabeledPoint[]
  ): ValidationReport {
    const assigned: string[] = [];
    const histogram: Record<string, number> = {};
    let correct = 0;
    for (const pt of points) {
      const candidates = grid.query([pt.gpsLon, pt.gpsLat], 120);
      let best: SegmentCandidate | null = null;
      for (const c of candidates) {
        if (!PARALLEL_ROUTES.includes(c.seg.routeId)) continue;
        if (!best || c.distance < best.distance) {
          best = c;
        }
      }
      if (!best) {
        let fallback: { routeId: string; distance: number } | null = null;
        for (const rid of PARALLEL_ROUTES) {
          const r = routesById.get(rid);
          if (!r) continue;
          const proj = projectPointToPolyline([pt.gpsLon, pt.gpsLat], r);
          if (!fallback || proj.distance < fallback.distance) {
            fallback = { routeId: rid, distance: proj.distance };
          }
        }
        const rid = fallback?.routeId ?? 'R01';
        assigned.push(rid);
        histogram[rid] = (histogram[rid] ?? 0) + 1;
        if (isARoute(rid)) correct++;
        continue;
      }
      const rid = best.seg.routeId;
      assigned.push(rid);
      histogram[rid] = (histogram[rid] ?? 0) + 1;
      if (isARoute(rid)) correct++;
    }
    const total = points.length;
    return {
      totalPoints: total,
      correctMatches: correct,
      accuracy: total > 0 ? correct / total : 0,
      falseSwitches: countFalseSwitches(assigned),
      routeHistogram: histogram,
    };
  }

  private findNearestRouteId(gpsLon: number, gpsLat: number): string {
    const candidates = this.parallelGrid.query([gpsLon, gpsLat], 120);
    let best: SegmentCandidate | null = null;
    for (const c of candidates) {
      if (!PARALLEL_ROUTES.includes(c.seg.routeId)) continue;
      if (!best || c.distance < best.distance) best = c;
    }
    if (best) return best.seg.routeId;
    let fallback: { routeId: string; distance: number } | null = null;
    for (const rid of PARALLEL_ROUTES) {
      const r = this.routesById.get(rid);
      if (!r) continue;
      const proj = projectPointToPolyline([gpsLon, gpsLat], r);
      if (!fallback || proj.distance < fallback.distance) {
        fallback = { routeId: rid, distance: proj.distance };
      }
    }
    return fallback?.routeId ?? 'R01';
  }

  runSequence(
    points: LabeledPoint[],
    useHMM: boolean,
    hdopScale = 1.0
  ): ValidationReport {
    const total = points.length;
    const assigned: string[] = [];
    const histogram: Record<string, number> = {};
    let correct = 0;
    if (useHMM) {
      const assigner = new SequenceAssigner(this.routesById, this.parallelGrid);
      const pendingAssignments: Map<number, string> = new Map();
      let baseTs = 1700000000000;
      for (let i = 0; i < total; i++) {
        const pt = points[i];
        const msg: GpsMessage = {
          bus: 0,
          ruta: 'R01',
          lat: pt.gpsLat,
          lon: pt.gpsLon,
          vel: 5.0,
          rumbo: 90,
          ts: baseTs + i * 1000,
          hdop: 3.0 * hdopScale,
          sats: 6,
        };
        const result = assigner.push(0, msg);
        if (result) {
          pendingAssignments.set(assigned.length, result.routeId);
        }
        const committedIdx = assigned.length;
        if (pendingAssignments.has(committedIdx)) {
          const rid = pendingAssignments.get(committedIdx)!;
          pendingAssignments.delete(committedIdx);
          assigned.push(rid);
          histogram[rid] = (histogram[rid] ?? 0) + 1;
          if (isARoute(rid)) correct++;
        } else {
          const fallbackRid = this.findNearestRouteId(pt.gpsLon, pt.gpsLat);
          assigned.push(fallbackRid);
          histogram[fallbackRid] = (histogram[fallbackRid] ?? 0) + 1;
          if (isARoute(fallbackRid)) correct++;
        }
      }
      while (assigned.length < total) {
        const idx = assigned.length;
        if (pendingAssignments.has(idx)) {
          const rid = pendingAssignments.get(idx)!;
          pendingAssignments.delete(idx);
          assigned.push(rid);
          histogram[rid] = (histogram[rid] ?? 0) + 1;
          if (isARoute(rid)) correct++;
        } else {
          const pt = points[idx];
          const fallbackRid = this.findNearestRouteId(pt.gpsLon, pt.gpsLat);
          assigned.push(fallbackRid);
          histogram[fallbackRid] = (histogram[fallbackRid] ?? 0) + 1;
          if (isARoute(fallbackRid)) correct++;
        }
      }
    } else {
      for (const pt of points) {
        const rid = this.findNearestRouteId(pt.gpsLon, pt.gpsLat);
        assigned.push(rid);
        histogram[rid] = (histogram[rid] ?? 0) + 1;
        if (isARoute(rid)) correct++;
      }
    }
    return {
      totalPoints: total,
      correctMatches: correct,
      accuracy: total > 0 ? correct / total : 0,
      falseSwitches: countFalseSwitches(assigned),
      routeHistogram: histogram,
    };
  }
}
