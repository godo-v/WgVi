import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VitalsSimulator } from '../app/js/vitalsSim.js';
import { SensorHub } from '../app/js/analysis/hub.js';
import { AnalysisEngine } from '../app/js/analysis/engine.js';
import { CollarModel } from '../app/js/ble/simulator.js';
import { parseLine } from '../app/js/ble/protocol.js';

// Run the simulator for `seconds`, one tick per second, and return the samples.
function run(sim, seconds, start = 1_000_000) {
  const out = [];
  for (let s = 0; s <= seconds; s++) out.push(...sim.tick(start + s * 1000));
  return out;
}

test('normal scenarios give heart rate every second, temperature and breathing every 5 s', () => {
  const samples = run(new VitalsSimulator({ restingHr: 85, seed: 1 }), 10);
  const of = (type) => samples.filter((s) => s.type === type);
  assert.equal(of('hr').length, 11);
  assert.equal(of('temp').length, 3);
  assert.equal(of('resp').length, 3);
  assert.ok(samples.every((s) => s.simulated), 'every sample is marked simulated');
  assert.ok(of('hr').every((s) => Math.abs(s.bpm - 85) < 10));
  assert.ok(of('temp').every((s) => Math.abs(s.celsius - 38.6) < 0.3));
});

test('a scenario drifts to its target and "off" stops that vital only', () => {
  const sim = new VitalsSimulator({ restingHr: 85, seed: 2 });
  run(sim, 2);
  sim.set('temp', 'fever');
  sim.set('hr', 'off');
  const later = run(sim, 120, 2_000_000);
  assert.equal(later.filter((s) => s.type === 'hr').length, 0);
  assert.ok(later.filter((s) => s.type === 'temp').at(-1).celsius > 39.9);
  assert.ok(later.some((s) => s.type === 'resp'));
});

test('simulated heart rate never steers activity detection', () => {
  // Same real accelerometer data with and without a simulated racing heart.
  const classify = (withHr) => {
    const hub = new SensorHub();
    const engine = new AnalysisEngine({ hub });
    const model = new CollarModel({ scenario: 'resting', seed: 3, accelOnly: true });
    const sim = new VitalsSimulator({ hr: 'exercise', seed: 3 });
    const start = 1_000_000;
    const states = [];
    for (let sec = 1; sec <= 40; sec++) {
      for (const line of model.step(1000)) {
        const sample = parseLine(line);
        if (sample) hub.ingest({ ...sample, at: start + sec * 1000 });
      }
      if (withHr) sim.tick(start + sec * 1000).forEach((s) => hub.ingest(s));
      states.push(engine.tick(start + sec * 1000).activity?.scores ?? null);
    }
    return states;
  };
  assert.deepEqual(classify(true), classify(false));
});

test('simulated vitals do not hide a silent collar', () => {
  const hub = new SensorHub();
  hub.ingest({ type: 'accel', t: 0, x: 0, y: -1, z: 0, at: 1000 });
  hub.ingest({ type: 'hr', t: null, bpm: 80, quality: 100, at: 60_000, simulated: true });
  assert.equal(hub.lastSampleAt, 1000);
});
