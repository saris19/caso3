import type { LonLat, Route, Segment } from './types';

const EARTH_RADIUS_METERS = 6371008.8;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export function projectEquirectangular(pt: LonLat, origin: LonLat): [number, number] {
  const latCos = Math.cos(origin[1] * DEG_TO_RAD);
  const x = (pt[0] - origin[0]) * DEG_TO_RAD * EARTH_RADIUS_METERS * latCos;
  const y = (pt[1] - origin[1]) * DEG_TO_RAD * EARTH_RADIUS_METERS;
  return [x, y];
}

export function inverseProject(xy: [number, number], origin: LonLat): LonLat {
  const latCos = Math.cos(origin[1] * DEG_TO_RAD);
  const lon = origin[0] + (xy[0] / (EARTH_RADIUS_METERS * latCos)) * RAD_TO_DEG;
  const lat = origin[1] + (xy[1] / EARTH_RADIUS_METERS) * RAD_TO_DEG;
  return [lon, lat];
}

export function haversineDistance(a: LonLat, b: LonLat): number {
  const dLat = (b[1] - a[1]) * DEG_TO_RAD;
  const dLon = (b[0] - a[0]) * DEG_TO_RAD;
  const lat1 = a[1] * DEG_TO_RAD;
  const lat2 = b[1] * DEG_TO_RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pointSegmentDistance(
  p: LonLat, a: LonLat, b: LonLat
): { distance: number; t: number; metersAlong: number } {
  const origin: LonLat = [
    (p[0] + a[0] + b[0]) / 3, (p[1] + a[1] + b[1]) / 3];
  const [px, py] = projectEquirectangular(p, origin);
  const [ax, ay] = projectEquirectangular(a, origin);
  const [bx, by] = projectEquirectangular(b, origin);
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t: number;
  if (lenSq === 0) {
    t = 0;
  } else {
    t = (px - ax) * dx + (py - ay) * dy;
    t = Math.max(0, Math.min(1, t / lenSq));
  }
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const segLen = Math.sqrt(lenSq);
  return {
    distance: Math.hypot(px - cx, py - cy),
    t,
    metersAlong: t * segLen,
  };
}

export function projectPointToPolyline(
  p: LonLat, route: Route
): { segmentIdx: number; t: number; metersFromStart: number; distance: number; closest: LonLat } {
  const polyline = route.polyline;
  let bestDist = Infinity;
  let bestSeg = 0;
  let bestT = 0;
  let bestClosest: LonLat = polyline[0];
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const result = pointSegmentDistance(p, a, b);
    if (result.distance < bestDist) {
      bestDist = result.distance;
      bestSeg = i;
      bestT = result.t;
      const segLen = haversineDistance(a, b);
      const ratio = segLen > 0 ? result.metersAlong / segLen : 0;
      bestClosest = [
        a[0] + (b[0] - a[0]) * ratio,
        a[1] + (b[1] - a[1]) * ratio,
      ];
    }
  }
  const startMeters = route.cumulativeMeters[bestSeg];
  const segLen = route.cumulativeMeters[bestSeg + 1] - startMeters;
  return {
    segmentIdx: bestSeg,
    t: bestT,
    metersFromStart: startMeters + bestT * segLen,
    distance: bestDist,
    closest: bestClosest,
  };
}

export function cumulativeMetersFromPolyline(polyline: LonLat[]): number[] {
  const result = new Array(polyline.length).fill(0);
  for (let i = 1; i < polyline.length; i++) {
    result[i] = result[i - 1] + haversineDistance(polyline[i - 1], polyline[i]);
  }
  return result;
}

export function routeToSegments(r: Route): Segment[] {
  const segments: Segment[] = [];
  for (let i = 0; i < r.polyline.length - 1; i++) {
    segments.push({
      routeId: r.id,
      index: i,
      a: r.polyline[i],
      b: r.polyline[i + 1],
      startMeters: r.cumulativeMeters[i],
      lengthMeters: r.cumulativeMeters[i + 1] - r.cumulativeMeters[i],
    });
  }
  return segments;
}
