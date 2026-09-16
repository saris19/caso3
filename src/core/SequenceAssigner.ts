import type { BusAssignment, GpsMessage, Route, SegmentCandidate } from './types';
import { SpatialGrid } from './SpatialGrid';

const WINDOW_N = 5;
const TAU = 20;
const STICKINESS_BONUS = 0.1;

interface WindowEntry {
  msg: GpsMessage;
  candidates: SegmentCandidate[];
}

interface BusState {
  window: WindowEntry[];
  lastCommitted: { routeId: string; segmentIdx: number } | null;
}

interface TrellisCell {
  logP: number;
  prevIdx: number;
}

export class SequenceAssigner {
  private routesById: Map<string, Route>;
  private grid: SpatialGrid;
  private buses: Map<number, BusState> = new Map();

  constructor(routesById: Map<string, Route>, grid: SpatialGrid) {
    this.routesById = routesById;
    this.grid = grid;
  }

  private getBus(bus: number): BusState {
    let s = this.buses.get(bus);
    if (!s) {
      s = { window: [], lastCommitted: null };
      this.buses.set(bus, s);
    }
    return s;
  }

  private emissionProb(cand: SegmentCandidate, hdop: number): number {
    const sigma = Math.max(4, Math.min(50, 6 + hdop * 2));
    return -cand.distance / sigma;
  }

  private transitionProb(
    cand1: SegmentCandidate, cand2: SegmentCandidate,
    speed1: number, deltaSeconds: number
  ): number {
    const expectedDelta = Math.max(1, speed1 * deltaSeconds);
    const actualDelta = cand2.metersFromStart - cand1.metersFromStart;
    const cost = Math.abs(actualDelta - expectedDelta);
    return -cost / TAU;
  }

  push(bus: number, msg: GpsMessage): BusAssignment | null {
    const state = this.getBus(bus);
    const radius = Math.max(60, 80 + msg.hdop * 10);
    const candidates = this.grid.query([msg.lon, msg.lat], radius);
    if (candidates.length === 0) {
      return null;
    }
    state.window.push({ msg, candidates });
    while (state.window.length > WINDOW_N) {
      state.window.shift();
    }
    if (state.window.length < WINDOW_N) {
      return null;
    }
    return this.viterbiDecode(bus, state);
  }

  private viterbiDecode(bus: number, state: BusState): BusAssignment | null {
    const win = state.window;
    const trellis: TrellisCell[][] = [];
    for (let t = 0; t < win.length; t++) {
      const cands = win[t].candidates;
      const row: TrellisCell[] = new Array(cands.length);
      if (t === 0) {
        for (let i = 0; i < cands.length; i++) {
          let logP = this.emissionProb(cands[i], win[t].msg.hdop);
          if (state.lastCommitted &&
              cands[i].seg.routeId === state.lastCommitted.routeId &&
              cands[i].seg.index === state.lastCommitted.segmentIdx) {
            logP += STICKINESS_BONUS;
          }
          row[i] = { logP, prevIdx: -1 };
        }
      } else {
        const prevCands = win[t - 1].candidates;
        const deltaSec = Math.max(0.1, (win[t].msg.ts - win[t - 1].msg.ts) / 1000);
        const speed1 = win[t - 1].msg.vel;
        for (let i = 0; i < cands.length; i++) {
          let bestLogP = -Infinity;
          let bestPrev = -1;
          for (let j = 0; j < prevCands.length; j++) {
            const trans = this.transitionProb(prevCands[j], cands[i], speed1, deltaSec);
            const lp = trellis[t - 1][j].logP + trans + this.emissionProb(cands[i], win[t].msg.hdop);
            if (lp > bestLogP) {
              bestLogP = lp;
              bestPrev = j;
            }
          }
          row[i] = { logP: bestLogP, prevIdx: bestPrev };
        }
      }
      trellis.push(row);
    }
    const lastRow = trellis[trellis.length - 1];
    let bestLastIdx = 0;
    let bestLastLogP = -Infinity;
    for (let i = 0; i < lastRow.length; i++) {
      if (lastRow[i].logP > bestLastLogP) {
        bestLastLogP = lastRow[i].logP;
        bestLastIdx = i;
      }
    }
    const committedIdx = 0;
    let ptr = bestLastIdx;
    for (let t = trellis.length - 1; t > committedIdx; t--) {
      ptr = trellis[t][ptr].prevIdx;
    }
    const committedCand = win[committedIdx].candidates[ptr];
    const committedMsg = win[committedIdx].msg;
    state.lastCommitted = { routeId: committedCand.seg.routeId, segmentIdx: committedCand.seg.index };
    state.window.shift();
    return this.buildAssignment(bus, committedMsg, committedCand);
  }

  private buildAssignment(bus: number, msg: GpsMessage, cand: SegmentCandidate): BusAssignment {
    return {
      bus,
      routeId: cand.seg.routeId,
      segmentIdx: cand.seg.index,
      segmentT: cand.t,
      metersFromStart: cand.metersFromStart,
      distanceToSegment: cand.distance,
      estimated: false,
      status: 1,
      serverTs: Date.now(),
      speed: msg.vel,
      heading: msg.rumbo,
      lat: msg.lat,
      lon: msg.lon,
    };
  }
}
