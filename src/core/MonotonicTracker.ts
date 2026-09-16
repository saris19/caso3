import type { BusAssignment } from './types';

const OOO_WINDOW_MS = 2000;
const SILENCE_THRESHOLD_MS = 40000;
const RETROCEDE_TOLERANCE_M = 0.5;
const DROP_RETROCEDE_M = 5;

interface BusRecord {
  lastAccepted: BusAssignment | null;
  lastAcceptedTs: number;
  bridgeCounter: number;
}

export class MonotonicTracker {
  private records: Map<number, BusRecord> = new Map();

  private getRecord(bus: number): BusRecord {
    let r = this.records.get(bus);
    if (!r) {
      r = { lastAccepted: null, lastAcceptedTs: 0, bridgeCounter: 0 };
      this.records.set(bus, r);
    }
    return r;
  }

  push(assn: BusAssignment): BusAssignment {
    const rec = this.getRecord(assn.bus);
    const last = rec.lastAccepted;
    if (!last) {
      rec.lastAccepted = { ...assn };
      rec.lastAcceptedTs = assn.serverTs;
      return assn;
    }
    if (assn.serverTs < last.serverTs - OOO_WINDOW_MS &&
        assn.metersFromStart < last.metersFromStart - DROP_RETROCEDE_M) {
      return assn;
    }
    let result: BusAssignment = { ...assn };
    const silenceGap = assn.serverTs - last.serverTs;
    if (silenceGap > SILENCE_THRESHOLD_MS) {
      result.estimated = true;
      rec.bridgeCounter = 3;
    } else if (rec.bridgeCounter > 0) {
      result.estimated = true;
      rec.bridgeCounter--;
    }
    if (result.metersFromStart < last.metersFromStart - RETROCEDE_TOLERANCE_M) {
      result.metersFromStart = last.metersFromStart;
    }
    rec.lastAccepted = result;
    rec.lastAcceptedTs = assn.serverTs;
    return result;
  }
}
