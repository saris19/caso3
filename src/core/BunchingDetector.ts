import type { BunchingAlert, ScheduleEntry } from './types';
import { DynamicOrder } from './DynamicOrder';
import { TravelTimeStore } from './TravelTimeStore';

const DEDUP_WINDOW_MS = 30000;
const PROJECTION_RATIO_THRESHOLD = 0.40;
const MIN_HORIZON_SEC = 120;
const DEFAULT_HORIZON_SEC = 180;

function getScheduledHeadway(schedule: ScheduleEntry[], serverTs: number): number | null {
  const hour = new Date(serverTs).getHours();
  for (const s of schedule) {
    if (s.hourStart < s.hourEnd) {
      if (hour >= s.hourStart && hour < s.hourEnd) return s.headwaySeconds;
    } else {
      if (hour >= s.hourStart || hour < s.hourEnd) return s.headwaySeconds;
    }
  }
  return null;
}

export class BunchingDetector {
  private ordered: DynamicOrder;
  private scheduleByRoute: Map<string, ScheduleEntry[]>;
  private travelStore?: TravelTimeStore;
  private lastAlertTs: Map<string, number> = new Map();

  constructor(
    ordered: DynamicOrder,
    scheduleByRoute: Map<string, ScheduleEntry[]>,
    travelStore?: TravelTimeStore
  ) {
    this.ordered = ordered;
    this.scheduleByRoute = scheduleByRoute;
    this.travelStore = travelStore;
  }

  private forecastHeadwayRatio(
    currentRatio: number,
    decelerationFactor: number,
    horizonSec: number
  ): number {
    const drift = (currentRatio - 1) * decelerationFactor * Math.min(1, horizonSec / 300);
    return Math.max(0, currentRatio + drift);
  }

  detect(routeId: string, serverTs: number): BunchingAlert[] {
    const alerts: BunchingAlert[] = [];
    const schedule = this.scheduleByRoute.get(routeId);
    if (!schedule) return alerts;
    const scheduledHeadway = getScheduledHeadway(schedule, serverTs);
    if (scheduledHeadway == null) return alerts;
    const intervals = this.ordered.getIntervals(routeId, this.travelStore);
    const buses = this.ordered.getOrdered(routeId);
    const busById = new Map(buses.map(b => [b.bus, b]));
    for (const iv of intervals) {
      if (!isFinite(iv.headwaySeconds) || iv.headwaySeconds <= 0) continue;
      const currentRatio = iv.headwaySeconds / scheduledHeadway;
      const bus = busById.get(iv.busId);
      const leader = busById.get(iv.leaderBusId);
      let decelerationFactor = 0;
      if (bus && leader) {
        const instSpeed = (bus.speed + leader.speed) / 2;
        if (this.travelStore) {
          const segStats = this.travelStore.getStats(routeId, bus.segmentIdx, serverTs);
          const median = segStats.median;
          if (median != null && median > 0 && bus.routeId === routeId) {
            const segLen = bus.routeId ? 100 : 100;
            const medianSpeed = segLen / median;
            if (medianSpeed > 0) {
              decelerationFactor = Math.max(-1, Math.min(1, (medianSpeed - instSpeed) / Math.max(1, medianSpeed)));
            }
          }
        }
      }
      const horizon = DEFAULT_HORIZON_SEC;
      const projectedRatio = this.forecastHeadwayRatio(currentRatio, decelerationFactor, horizon);
      if (projectedRatio < PROJECTION_RATIO_THRESHOLD && horizon >= MIN_HORIZON_SEC) {
        const key = `${routeId}:${iv.busId}`;
        const lastTs = this.lastAlertTs.get(key) ?? 0;
        if (serverTs - lastTs >= DEDUP_WINDOW_MS) {
          this.lastAlertTs.set(key, serverTs);
          const severity = projectedRatio < 0.25 ? 'critical' : 'warning';
          alerts.push({
            id: `${routeId}-${iv.busId}-${serverTs}`,
            routeId,
            busId: iv.busId,
            leaderBusId: iv.leaderBusId,
            projectedHeadwayRatio: projectedRatio,
            projectedHeadwaySeconds: projectedRatio * scheduledHeadway,
            scheduledHeadwaySeconds: scheduledHeadway,
            horizonSeconds: horizon,
            serverTs,
            severity,
          });
        }
      }
    }
    return alerts;
  }
}
