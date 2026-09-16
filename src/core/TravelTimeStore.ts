import { PSquaredTracker, makeMedianP85 } from './PSquaredTracker';

const BUCKETS: Array<{ start: number; end: number; idx: number }> = [
  { start: 6, end: 8, idx: 0 },
  { start: 8, end: 10, idx: 1 },
  { start: 10, end: 16, idx: 2 },
  { start: 16, end: 19, idx: 3 },
  { start: 19, end: 22, idx: 4 },
  { start: 22, end: 6, idx: 5 },
];

export function bucketOfHour(hour: number): number {
  for (const b of BUCKETS) {
    if (b.start < b.end) {
      if (hour >= b.start && hour < b.end) return b.idx;
    } else {
      if (hour >= b.start || hour < b.end) return b.idx;
    }
  }
  return 5;
}

interface TTEntry {
  median: PSquaredTracker;
  p85: PSquaredTracker;
}

export class TravelTimeStore {
  private entries: Map<string, TTEntry> = new Map();

  private key(routeId: string, segmentIdx: number, bucket: number): string {
    return `${routeId}:${segmentIdx}_${bucket}`;
  }

  onPassSegment(routeId: string, segmentIdx: number, serverTsMs: number, traversalSeconds: number): void {
    if (!isFinite(traversalSeconds) || traversalSeconds <= 0) return;
    const hour = new Date(serverTsMs).getHours();
    const bucket = bucketOfHour(hour);
    const k = this.key(routeId, segmentIdx, bucket);
    let entry = this.entries.get(k);
    if (!entry) {
      entry = makeMedianP85();
      this.entries.set(k, entry);
    }
    entry.median.addObservation(traversalSeconds);
    entry.p85.addObservation(traversalSeconds);
  }

  getStats(routeId: string, segmentIdx: number, serverTsMs: number): { median: number | null; p85: number | null } {
    const hour = new Date(serverTsMs).getHours();
    const bucket = bucketOfHour(hour);
    const k = this.key(routeId, segmentIdx, bucket);
    const entry = this.entries.get(k);
    if (!entry) return { median: null, p85: null };
    const median = entry.median.value;
    const p85 = entry.p85.value;
    return {
      median: isFinite(median) ? median : null,
      p85: isFinite(p85) ? p85 : null,
    };
  }
}
