import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accelFeatures } from '../app/js/analysis/features.js';
import { ActivityClassifier } from '../app/js/analysis/activity.js';
import { AlertEngine } from '../app/js/analysis/alerts.js';
import { vitalsFor, activityGoal } from '../app/js/analysis/profile.js';
import { mulberry32, gaussian } from '../app/js/util.js';
import { runScenario, T0 } from './helpers.js';

const fs = 25;
function window(fn, seconds = 4) {
  return Array.from({ length: seconds * fs }, (_, i) => ({ t: (i * 1000) / fs, ...fn(i / fs) }));
}

test('features: rhythmic head bob gives cadence, periodicity and VeDBA', () => {
  const f = accelFeatures(window((t) => ({ x: 0.05, y: -1 + 0.3 * Math.sin(2 * Math.PI * 2 * t), z: 0.1 })));
  assert.ok(Math.abs(f.cadenceHz - 2) < 0.15, `cadence ${f.cadenceHz}`);
  assert.ok(f.periodicity > 0.9, `periodicity ${f.periodicity}`);
  assert.ok(Math.abs(f.vedba - (0.3 * 2) / Math.PI) < 0.02, `vedba ${f.vedba}`);
  assert.ok(Math.abs(f.fs - fs) < 0.01);
});

test('features: random jostling has no rhythm; a still collar has no movement', () => {
  const rand = mulberry32(3);
  const noisy = accelFeatures(window(() => ({ x: 0.1 * gaussian(rand), y: -1 + 0.1 * gaussian(rand), z: 0.1 * gaussian(rand) })));
  assert.ok(noisy.periodicity < 0.3, `periodicity ${noisy.periodicity}`);
  const still = accelFeatures(window(() => ({ x: 0, y: -1, z: 0 })));
  assert.ok(still.vedba < 1e-9);
  assert.equal(still.periodicity, 0);
});

test('features: too few samples returns null', () => {
  assert.equal(accelFeatures(window(() => ({ x: 0, y: -1, z: 0 }), 0.4)), null);
});

// Accelerometer evidence halfway between a brisk walk and a run.
const ambiguous = { vedba: 0.5, periodicity: 0.9, burstiness: 0.05, cadenceHz: 2.4 };

test('fusion: heart rate breaks a tie the accelerometer cannot', () => {
  const calm = new ActivityClassifier().update({ features: ambiguous, hr: 110, restingHr: 85, now: 0 });
  const racing = new ActivityClassifier().update({ features: ambiguous, hr: 170, restingHr: 85, now: 0 });
  assert.equal(calm.state, 'walking');
  assert.equal(racing.state, 'running');
  assert.ok(calm.usedHr && racing.usedHr);
});

test('fusion: without heart rate the accelerometer decides alone', () => {
  const r = new ActivityClassifier().update({ features: ambiguous, hr: null, restingHr: 85, now: 0 });
  assert.equal(r.usedHr, false);
  assert.equal(r.state, 'walking');
});

test('fusion: a racing heart alone never turns rest into exercise', () => {
  const still = { vedba: 0.01, periodicity: 0, burstiness: 0.1, cadenceHz: 0 };
  const r = new ActivityClassifier().update({ features: still, hr: 180, restingHr: 85, now: 0 });
  assert.equal(r.state, 'resting');
});

test('sleep: long still rest with a calm heart becomes sleeping; movement wakes', () => {
  const c = new ActivityClassifier({ sleepAfterSec: 60 });
  const still = { vedba: 0.005, periodicity: 0, burstiness: 0.1, cadenceHz: 0 };
  let state;
  for (let s = 0; s <= 60; s++) state = c.update({ features: still, hr: 80, restingHr: 85, now: s * 1000 }).state;
  assert.equal(state, 'sleeping');
  const walk = { vedba: 0.2, periodicity: 0.95, burstiness: 0.05, cadenceHz: 1.8 };
  for (let s = 61; s < 66; s++) state = c.update({ features: walk, hr: 100, restingHr: 85, now: s * 1000 }).state;
  assert.equal(state, 'walking');
});

const expectations = {
  resting: 'resting',
  light: 'light',
  walking: 'walking',
  running: 'running',
};
for (const [scenario, expected] of Object.entries(expectations)) {
  test(`simulator end-to-end: ${scenario} is classified as ${expected}`, () => {
    for (const seed of [7, 11]) {
      const { share } = runScenario(scenario, 60, { seed });
      assert.ok(share(expected) > 0.95, `${scenario} seed ${seed}: ${share(expected)}`);
    }
  });
}

test('simulator end-to-end: playing is mostly playing (pauses read as light activity)', () => {
  for (const seed of [7, 11, 99]) {
    const { share, counts } = runScenario('playing', 120, { seed });
    assert.ok(share('playing') > 0.7, JSON.stringify(counts));
    assert.ok(share('walking') + share('running') < 0.05, JSON.stringify(counts));
  }
});

test('simulator end-to-end: sleeping after two minutes of still rest', () => {
  const { last } = runScenario('sleeping', 150);
  assert.equal(last.activity.state, 'sleeping');
});

test('simulator end-to-end: fever raises a temperature alert', () => {
  const { alerts } = runScenario('fever', 60);
  assert.ok(alerts.has('temp-high'));
});

test('simulator end-to-end: stress = resting + racing heart + fast breathing', () => {
  const { alerts, share } = runScenario('stress', 90);
  assert.ok(share('resting') > 0.95);
  assert.ok(alerts.has('hr-rest-high'));
  assert.ok(alerts.has('resp-rest-high'));
});

test('simulator end-to-end: a limp lowers gait symmetry and raises an alert', () => {
  const sound = runScenario('walking', 60).last.gait;
  const limp = runScenario('limping', 60);
  assert.ok(sound.symmetry > 0.9, `sound ${sound.symmetry}`);
  assert.ok(limp.last.gait.symmetry < 0.85, `limp ${limp.last.gait.symmetry}`);
  assert.ok(limp.alerts.has('gait-asymmetry'));
});

test('engine counts time per activity and learns resting HR only after settling', () => {
  const { engine, last } = runScenario('resting', 120);
  assert.ok(last.totals.seconds.resting >= 100);
  assert.ok(engine.learnedRestingHr !== null);
  assert.ok(Math.abs(engine.learnedRestingHr - 85) < 5, `learned ${engine.learnedRestingHr}`);
  const walking = runScenario('walking', 120);
  assert.equal(walking.engine.learnedRestingHr, null, 'never learns while walking');
});

test('alerts: must hold for holdSec, then clear when the condition ends', () => {
  const engine = new AlertEngine();
  const vitals = vitalsFor({ weightKg: 20, ageYears: 4 });
  const ctx = (now, tempC) => ({ now, tempC, state: 'resting', hr: null, vitals, connected: true, lastSampleAt: now });
  assert.equal(engine.evaluate(ctx(T0, 39.8)).active.length, 0);
  const raised = engine.evaluate(ctx(T0 + 10_000, 39.8));
  assert.deepEqual(raised.raised.map((a) => a.id), ['temp-high']);
  assert.equal(engine.evaluate(ctx(T0 + 11_000, 39.8)).raised.length, 0, 'not raised twice');
  assert.equal(engine.evaluate(ctx(T0 + 12_000, 38.6)).active.length, 0);
});

test('alerts: signal lost while connected', () => {
  const engine = new AlertEngine();
  const vitals = vitalsFor({ weightKg: 20 });
  const r = engine.evaluate({ now: T0 + 20_000, lastSampleAt: T0, connected: true, vitals });
  assert.ok(r.active.some((a) => a.id === 'signal-lost'));
});

test('profile: size, puppy heart rates and overweight exercise tip', () => {
  assert.equal(vitalsFor({ weightKg: 5 }).size, 'small');
  assert.equal(vitalsFor({ weightKg: 40 }).size, 'large');
  assert.ok(vitalsFor({ weightKg: 20, ageYears: 0.5 }).restingHr > vitalsFor({ weightKg: 20, ageYears: 3 }).restingHr);
  const goal = activityGoal({ weightKg: 30, idealWeightKg: 25, ageYears: 4 });
  assert.equal(goal.minutes, 90);
  assert.match(goal.tips[0], /20% above ideal weight/);
});
