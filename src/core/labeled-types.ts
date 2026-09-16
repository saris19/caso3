export interface LabeledPoint {
  gtLon: number;
  gtLat: number;
  gpsLon: number;
  gpsLat: number;
  trueRouteId: string;
  trueStreet: 'A' | 'B';
  trueMetersFromStart: number;
  flipped: boolean;
}

export interface ValidationReport {
  totalPoints: number;
  correctMatches: number;
  accuracy: number;
  falseSwitches: number;
  routeHistogram: Record<string, number>;
  baselineFalseSwitches?: number;
}
