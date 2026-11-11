// Simulated heart rate, temperature and breathing.
//
// The collar only measures movement (accelerometer). Until it has vital-sign
// sensors, these readings are simulated so the rest of the app (cards, charts,
// alerts) can still be demonstrated. Each vital has its own scenario, picked
// from a dropdown on its card. Every sample is marked `simulated: true`; the
// activity classifier ignores simulated heart rate, so activity always comes
// from the real accelerometer alone.

import { mulberry32, gaussian } from './util.js';

export const HR_SCENARIOS = {
  normal: 'Normal (resting)',
  exercise: 'Exercising',
  stress: 'Racing heart at rest (stress / pain)',
  slow: 'Slow heart (bradycardia)',
  poor: 'Poor sensor contact',
  off: 'Off',
};

export const TEMP_SCENARIOS = {
  normal: 'Normal',
  elevated: 'Slightly raised',
  fever: 'Fever',
  low: 'Low (hypothermia)',
  off: 'Off',
};

export const RESP_SCENARIOS = {
  normal: 'Normal (resting)',
  panting: 'Panting (after exercise)',
  fast: 'Fast at rest (distress)',
  slow: 'Slow (deep sleep)',
  off: 'Off',
};

// Targets. Heart rate is a multiple of the dog's typical resting rate.
const HR_FACTOR = { normal: 1.0, exercise: 1.8, stress: 1.65, slow: 0.55, poor: 1.0 };
const TEMP_C = { normal: 38.6, elevated: 39.4, fever: 40.1, low: 37.0 };
const RESP_BPM = { normal: 22, panting: 120, fast: 45, slow: 14 };

const HR_EVERY_MS = 1000;
const SLOW_EVERY_MS = 5000; // temperature and breathing

export class VitalsSimulator {
  constructor({ hr = 'normal', temp = 'normal', resp = 'normal', restingHr = 85, seed = Date.now() % 1e9 } = {}) {
    this.rand = mulberry32(seed);
    this.restingHr = restingHr;
    this.scenario = { hr, temp, resp };
    // Start at the targets so the cards show sensible values straight away.
    this.value = { hr: this.#target('hr') ?? restingHr, temp: this.#target('temp') ?? 38.6, resp: this.#target('resp') ?? 22 };
    this.nextAt = { hr: 0, slow: 0 };
    this.lastAt = null;
  }

  set(kind, scenario) {
    this.scenario[kind] = scenario;
    this.nextAt[kind === 'hr' ? 'hr' : 'slow'] = 0; // show the change at once
  }

  #target(kind) {
    const s = this.scenario[kind];
    if (kind === 'hr') return HR_FACTOR[s] != null ? HR_FACTOR[s] * this.restingHr : null;
    if (kind === 'temp') return TEMP_C[s] ?? null;
    return RESP_BPM[s] ?? null;
  }

  // Samples due at wall-clock time `now` (ms), in the same shape the collar
  // protocol parser produces, so they go straight into the SensorHub.
  tick(now) {
    const dt = this.lastAt == null ? 0 : Math.min(10, (now - this.lastAt) / 1000);
    this.lastAt = now;
    const r = this.rand;
    // Values drift towards the target: changes take ~10-20 s, like a real dog.
    const approach = (kind, tauSec) => {
      const target = this.#target(kind);
      if (target != null) this.value[kind] += (target - this.value[kind]) * Math.min(1, dt / tauSec);
      return target != null;
    };

    const samples = [];
    if (now >= this.nextAt.hr) {
      this.nextAt.hr = now + HR_EVERY_MS;
      if (approach('hr', 12)) {
        const poor = this.scenario.hr === 'poor';
        samples.push({
          type: 'hr',
          t: null,
          at: now,
          bpm: Math.round(this.value.hr + 2 * gaussian(r) + (poor ? 40 * (r() - 0.5) : 0)),
          quality: poor ? Math.round(10 + 15 * r()) : Math.round(90 + 10 * r()),
          simulated: true,
        });
      }
    } else approach('hr', 12);

    if (now >= this.nextAt.slow) {
      this.nextAt.slow = now + SLOW_EVERY_MS;
      if (approach('temp', 20)) {
        samples.push({ type: 'temp', t: null, at: now, celsius: Math.round((this.value.temp + 0.05 * gaussian(r)) * 100) / 100, simulated: true });
      }
      if (approach('resp', 8)) {
        samples.push({ type: 'resp', t: null, at: now, bpm: Math.max(1, Math.round(this.value.resp + gaussian(r))), simulated: true });
      }
    } else {
      approach('temp', 20);
      approach('resp', 8);
    }
    return samples;
  }
}
