import { CollarModel } from '../app/js/ble/simulator.js';
import { parseLine } from '../app/js/ble/protocol.js';
import { SensorHub } from '../app/js/analysis/hub.js';
import { AnalysisEngine } from '../app/js/analysis/engine.js';

export const T0 = Date.UTC(2026, 9, 26, 12, 0, 0);

// Run a simulator scenario through parser → hub → engine in simulated time.
export function runScenario(scenario, seconds, { seed = 7, warmupSec = 15 } = {}) {
  const model = new CollarModel({ scenario, seed });
  const hub = new SensorHub();
  const engine = new AnalysisEngine({ hub });
  const counts = {};
  const alerts = new Set();
  let last = null;
  for (let s = 0; s < seconds; s++) {
    for (let k = 0; k < 10; k++) {
      const at = T0 + s * 1000 + k * 100;
      for (const line of model.step(100)) {
        const sample = parseLine(line);
        if (sample) hub.ingest({ ...sample, at });
      }
    }
    last = engine.tick(T0 + (s + 1) * 1000);
    if (s >= warmupSec && last.activity) counts[last.activity.state] = (counts[last.activity.state] ?? 0) + 1;
    for (const a of last.alerts.active) alerts.add(a.id);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const share = (state) => (counts[state] ?? 0) / total;
  return { counts, share, alerts, last, engine, hub };
}
