export class PSquaredTracker {
  private p: number;
  private q: number[] = new Array(5).fill(0);
  private n: number[] = [0, 0, 0, 0, 0];
  private nx: number[] = [0, 0, 0, 0, 0];
  private count: number = 0;

  constructor(p: number) {
    this.p = p;
  }

  addObservation(x: number): void {
    if (this.count < 5) {
      this.q[this.count] = x;
      this.count++;
      if (this.count === 5) {
        this.q.sort((a, b) => a - b);
        this.n = [0, 1, 2, 3, 4];
        this.nx = [
          0,
          2 * this.p,
          4 * this.p,
          2 + 2 * this.p,
          4,
        ];
      }
      return;
    }
    this.count++;
    let k: number;
    if (x < this.q[0]) {
      this.q[0] = x;
      k = 0;
    } else if (x < this.q[1]) {
      k = 0;
    } else if (x < this.q[2]) {
      k = 1;
    } else if (x < this.q[3]) {
      k = 2;
    } else if (x <= this.q[4]) {
      k = 3;
    } else {
      this.q[4] = x;
      k = 3;
    }
    for (let i = k + 1; i < 5; i++) {
      this.n[i]++;
    }
    for (let i = 0; i < 5; i++) {
      this.nx[i] += i === 0 ? 0 : i === 4 ? 0 : (i === 1 ? this.p / 2 : i === 2 ? this.p : (1 + this.p) / 2);
    }
    for (let i = 1; i <= 3; i++) {
      const d = this.nx[i] - this.n[i];
      if ((d >= 1 && this.n[i + 1] - this.n[i] > 1) || (d <= -1 && this.n[i - 1] - this.n[i] < -1)) {
        const ds = d >= 0 ? 1 : -1;
        const qi = this.q[i];
        const qi1 = this.q[i + 1];
        const qim1 = this.q[i - 1];
        const ni = this.n[i];
        const ni1 = this.n[i + 1];
        const nim1 = this.n[i - 1];
        const dfParabolic = (ni - nim1 + ds) * (qi1 - qi) / (ni1 - ni) +
                            (ni1 - ni - ds) * (qi - qim1) / (ni - nim1);
        if (qim1 < dfParabolic && dfParabolic < qi1) {
          this.q[i] = qi + ds * dfParabolic;
        } else {
          this.q[i] = qi + ds * (this.q[i + ds] - qi) / (this.n[i + ds] - ni);
        }
        this.n[i] += ds;
      }
    }
  }

  get value(): number {
    if (this.count === 0) return NaN;
    if (this.count < 5) {
      const sorted = [...this.q.slice(0, this.count)].sort((a, b) => a - b);
      const idx = Math.floor(this.p * (sorted.length - 1));
      return sorted[Math.min(idx, sorted.length - 1)];
    }
    return this.q[2];
  }

  reset(): void {
    this.q = new Array(5).fill(0);
    this.n = [0, 0, 0, 0, 0];
    this.nx = [0, 0, 0, 0, 0];
    this.count = 0;
  }
}

export function makeMedianP85(): { median: PSquaredTracker; p85: PSquaredTracker } {
  return {
    median: new PSquaredTracker(0.5),
    p85: new PSquaredTracker(0.85),
  };
}
