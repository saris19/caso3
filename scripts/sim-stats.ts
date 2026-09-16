import { FleetSimulator } from '../src/sim/FleetSimulator.js';
import type { Route } from '../src/core/types.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

function loadRoutes(): Route[] {
  const path = resolve(projectRoot, 'data', 'routes.json');
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as Route[];
}

async function main(): Promise<void> {
  const routes = loadRoutes();
  const simulator = new FleetSimulator({
    routes,
    seed: 42,
    speedFactor: 1.0,
    batchHertz: 10,
  });

  const totalTicks = 3000;
  for (let i = 0; i < totalTicks; i++) {
    (simulator as any).advanceTick();
  }

  const stats = simulator.getStats();
  process.stdout.write(JSON.stringify(stats, null, 2) + '\n');

  const checksum = await simulator.checksumFromTicks(1000);
  process.stdout.write('\nSHA-256 checksum (1000 ticks): ' + checksum + '\n');

  process.exit(0);
}

main().catch((err) => {
  console.error('sim-stats failed:', err);
  process.exit(1);
});
