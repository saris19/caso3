import type { BunchingAlert, BusAssignment, RetentionRecommendation, ScheduleEntry, Stop } from './types';
import { DynamicOrder } from './DynamicOrder';

const MAX_BEHIND_RATIO = 1.6;

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

function findNextStop(stops: Stop[], metersFromStart: number, totalMeters: number): Stop | null {
  if (stops.length === 0) return null;
  let best: Stop | null = null;
  let bestDelta = Infinity;
  for (const stop of stops) {
    let delta = stop.metersFromStart - metersFromStart;
    if (delta < 0) delta += totalMeters;
    if (delta >= 0 && delta < bestDelta) {
      bestDelta = delta;
      best = stop;
    }
  }
  return best;
}

interface CandidateRec {
  alert: BunchingAlert;
  stop: Stop;
  minutes: number;
  resultingGapRatio: number;
  priority: number;
  routeHeadwaySec: number;
}

export class RetentionRecommender {
  private stopsByRoute: Map<string, Stop[]>;
  private routeTotalMeters: Map<string, number>;

  constructor(
    stopsByRoute: Map<string, Stop[]>,
    routeTotalMeters: Map<string, number>
  ) {
    this.stopsByRoute = stopsByRoute;
    this.routeTotalMeters = routeTotalMeters;
  }

  recommend(
    alerts: BunchingAlert[],
    ordered: DynamicOrder,
    stopsById: Map<string, Stop>,
    stopsUsage: Map<string, Set<number>>,
    scheduleMap: Map<string, ScheduleEntry[]>
  ): RetentionRecommendation[] {
    const candidates: CandidateRec[] = [];
    for (const alert of alerts) {
      const routeStops = this.stopsByRoute.get(alert.routeId);
      const totalMeters = this.routeTotalMeters.get(alert.routeId);
      const schedule = scheduleMap.get(alert.routeId);
      if (!routeStops || totalMeters == null || !schedule) continue;
      const buses = ordered.getOrdered(alert.routeId);
      const bus = buses.find(b => b.bus === alert.busId);
      if (!bus) continue;
      const stop = findNextStop(routeStops, bus.metersFromStart, totalMeters);
      if (!stop) continue;
      const scheduledHeadway = getScheduledHeadway(schedule, alert.serverTs);
      if (scheduledHeadway == null) continue;
      const intervals = ordered.getIntervals(alert.routeId);
      const iv = intervals.find(i => i.busId === alert.busId);
      if (!iv) continue;
      const currentHeadway = iv.headwaySeconds;
      const deficit = scheduledHeadway - currentHeadway;
      if (deficit <= 0) continue;
      const minutesRaw = Math.ceil(deficit / 60 * 10) / 10;
      let minutes = Math.max(0.5, Math.min(10, minutesRaw));
      const behindGap = this.behindGapSeconds(alert.routeId, alert.busId, ordered);
      const resultingGapBehind = behindGap + minutes * 60;
      const resultingGapRatio = resultingGapBehind / scheduledHeadway;
      if (resultingGapRatio > MAX_BEHIND_RATIO) {
        const maxMinutes = Math.max(0, (MAX_BEHIND_RATIO * scheduledHeadway - behindGap) / 60);
        if (maxMinutes < 0.5) continue;
        minutes = Math.min(minutes, maxMinutes);
      }
      const priority = (1 - alert.projectedHeadwayRatio) * 1000 - alert.busId * 0.001;
      candidates.push({
        alert,
        stop,
        minutes,
        resultingGapRatio,
        priority,
        routeHeadwaySec: scheduledHeadway,
      });
    }
    candidates.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.routeHeadwaySec - a.routeHeadwaySec;
    });
    const results: RetentionRecommendation[] = [];
    for (const cand of candidates) {
      const usageKey = cand.stop.sharedStopId ?? cand.stop.id;
      const used = stopsUsage.get(usageKey) ?? new Set<number>();
      if (used.size >= cand.stop.capacity) continue;
      used.add(cand.alert.busId);
      stopsUsage.set(usageKey, used);
      results.push({
        id: `rec-${cand.alert.id}`,
        busId: cand.alert.busId,
        routeId: cand.alert.routeId,
        stopId: cand.stop.id,
        stopSharedId: cand.stop.sharedStopId,
        minutes: cand.minutes,
        resultingGapRatio: cand.resultingGapRatio,
        priority: cand.priority,
        reason: `Bunching projected ratio ${cand.alert.projectedHeadwayRatio.toFixed(2)}; retain ${cand.minutes.toFixed(1)} min at stop ${cand.stop.id}`,
      });
    }
    return results;
  }

  private behindGapSeconds(routeId: string, busId: number, ordered: DynamicOrder): number {
    const buses = ordered.getOrdered(routeId);
    if (buses.length < 2) return 0;
    const intervals = ordered.getIntervals(routeId);
    for (const iv of intervals) {
      if (iv.leaderBusId === busId) {
        return isFinite(iv.headwaySeconds) ? iv.headwaySeconds : 0;
      }
    }
    return 0;
  }
}
