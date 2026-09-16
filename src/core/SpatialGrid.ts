// Cell size 100m: center density ~25 segments per 100m cell; periphery ~2 segments; a radius-80m query touches at most 9 cells, which is bounded.
import type { LonLat, Segment, SegmentCandidate } from './types';
import { projectEquirectangular, pointSegmentDistance } from './geo';

interface GridCell {
  segments: Segment[];
}

export class SpatialGrid {
  private cellSize: number;
  private origin: LonLat;
  private cells: Map<string, GridCell> = new Map();
  private allSegments: Segment[];

  constructor(segments: Segment[], cellSize: number = 100) {
    this.cellSize = cellSize;
    this.allSegments = segments;
    if (segments.length === 0) {
      this.origin = [0, 0];
      return;
    }
    let sumLon = 0, sumLat = 0;
    for (const s of segments) {
      sumLon += s.a[0] + s.b[0];
      sumLat += s.a[1] + s.b[1];
    }
    this.origin = [sumLon / (2 * segments.length), sumLat / (2 * segments.length)];
    for (const s of segments) {
      this.insertSegment(s);
    }
  }

  private key(ix: number, iy: number): string {
    return `${ix},${iy}`;
  }

  private projectPoint(p: LonLat): [number, number] {
    return projectEquirectangular(p, this.origin);
  }

  private cellOfXY(xy: [number, number]): [number, number] {
    return [
      Math.floor(xy[0] / this.cellSize),
      Math.floor(xy[1] / this.cellSize),
    ];
  }

  private insertSegment(seg: Segment): void {
    const aXY = this.projectPoint(seg.a);
    const bXY = this.projectPoint(seg.b);
    const minX = Math.min(aXY[0], bXY[0]);
    const maxX = Math.max(aXY[0], bXY[0]);
    const minY = Math.min(aXY[1], bXY[1]);
    const maxY = Math.max(aXY[1], bXY[1]);
    const ixMin = Math.floor(minX / this.cellSize);
    const ixMax = Math.floor(maxX / this.cellSize);
    const iyMin = Math.floor(minY / this.cellSize);
    const iyMax = Math.floor(maxY / this.cellSize);
    for (let ix = ixMin; ix <= ixMax; ix++) {
      for (let iy = iyMin; iy <= iyMax; iy++) {
        const k = this.key(ix, iy);
        let cell = this.cells.get(k);
        if (!cell) {
          cell = { segments: [] };
          this.cells.set(k, cell);
        }
        cell.segments.push(seg);
      }
    }
  }

  query(pt: LonLat, radiusMeters: number): SegmentCandidate[] {
    const ptXY = this.projectPoint(pt);
    const [cx, cy] = this.cellOfXY(ptXY);
    const cellSpan = Math.ceil(radiusMeters / this.cellSize);
    const seen = new Set<string>();
    const candidates: SegmentCandidate[] = [];
    for (let dx = -cellSpan; dx <= cellSpan; dx++) {
      for (let dy = -cellSpan; dy <= cellSpan; dy++) {
        const ix = cx + dx;
        const iy = cy + dy;
        const k = this.key(ix, iy);
        const cell = this.cells.get(k);
        if (!cell) continue;
        for (const seg of cell.segments) {
          const segKey = `${seg.routeId}:${seg.index}`;
          if (seen.has(segKey)) continue;
          seen.add(segKey);
          const result = pointSegmentDistance(pt, seg.a, seg.b);
          if (result.distance <= radiusMeters) {
            candidates.push({
              seg,
              distance: result.distance,
              t: result.t,
              metersFromStart: seg.startMeters + result.t * seg.lengthMeters,
            });
          }
        }
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    return candidates;
  }

  sizeBytes(): number {
    let total = 0;
    for (const [, cell] of this.cells) {
      total += 16 + cell.segments.length * 8;
    }
    total += this.allSegments.length * 8;
    return total;
  }
}
