// Per-route ordered list: sorted array + binary splice, O(n) per upsert where n ~14 buses/route is cheaper than a skip list.
import type { BusAssignment, Route } from './types';
import type { TravelTimeStore } from './TravelTimeStore';

interface RouteState {
  buses: BusAssignment[];
  totalMeters: number;
}

interface Interval {
  busId: number;
  leaderBusId: number;
  headwaySeconds: number;
  meters: number;
}

function bisectLeft(arr: BusAssignment[], x: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].metersFromStart < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class DynamicOrder {
  private routes: Map<string, RouteState> = new Map();
  private busToRoute: Map<number, string> = new Map();

  constructor(routesById: Map<string, Route>) {
    for (const [id, r] of routesById) {
      this.routes.set(id, { buses: [], totalMeters: r.totalMeters });
    }
  }

  upsert(assn: BusAssignment): void {
    const prevRoute = this.busToRoute.get(assn.bus);
    if (prevRoute && prevRoute !== assn.routeId) {
      this.removeFromRoute(prevRoute, assn.bus);
    }
    this.busToRoute.set(assn.bus, assn.routeId);
    const state = this.routes.get(assn.routeId);
    if (!state) return;
    const existingIdx = state.buses.findIndex(b => b.bus === assn.bus);
    if (existingIdx >= 0) {
      state.buses.splice(existingIdx, 1);
    }
    const insertAt = bisectLeft(state.buses, assn.metersFromStart);
    state.buses.splice(insertAt, 0, assn);
  }

  remove(busId: number): void {
    const route = this.busToRoute.get(busId);
    if (!route) return;
    this.removeFromRoute(route, busId);
    this.busToRoute.delete(busId);
  }

  private removeFromRoute(routeId: string, busId: number): void {
    const state = this.routes.get(routeId);
    if (!state) return;
    const idx = state.buses.findIndex(b => b.bus === busId);
    if (idx >= 0) state.buses.splice(idx, 1);
  }

  getOrdered(routeId: string): BusAssignment[] {
    const state = this.routes.get(routeId);
    return state ? [...state.buses] : [];
  }

  getIntervals(routeId: string, scheduler?: TravelTimeStore): Interval[] {
    const state = this.routes.get(routeId);
    if (!state || state.buses.length < 2) return [];
    const results: Interval[] = [];
    const buses = state.buses;
    for (let i = 0; i < buses.length; i++) {
      const bus = buses[i];
      const leaderIdx = (i + 1) % buses.length;
      const leader = buses[leaderIdx];
      let meters: number;
      if (leaderIdx === 0) {
        meters = (state.totalMeters - bus.metersFromStart) + leader.metersFromStart;
      } else {
        meters = leader.metersFromStart - bus.metersFromStart;
      }
      let headwaySeconds: number;
      const avgSpeed = (bus.speed + leader.speed) / 2;
      if (scheduler && avgSpeed > 0.1) {
        const segIdx = Math.min(bus.segmentIdx, leader.segmentIdx);
        const stats = scheduler.getStats(routeId, segIdx, bus.serverTs);
        const median = stats.median;
        if (median != null && median > 0) {
          const route = this.routes.get(routeId);
          const segLen = route ? route.totalMeters / Math.max(1, buses.length) : 1;
          headwaySeconds = (meters / segLen) * median;
        } else {
          headwaySeconds = meters / avgSpeed;
        }
      } else if (avgSpeed > 0.1) {
        headwaySeconds = meters / avgSpeed;
      } else {
        headwaySeconds = Infinity;
      }
      results.push({
        busId: bus.bus,
        leaderBusId: leader.bus,
        headwaySeconds,
        meters,
      });
    }
    return results;
  }
}
