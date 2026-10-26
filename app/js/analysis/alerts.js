// Health alerts. Each rule must hold for `holdSec` before it is raised, so a
// single noisy reading doesn't alarm the owner. Several rules combine sensors:
// a fast heart or fast breathing only matters if the accelerometer says the
// dog is resting.

import { ANALYSIS, VITALS } from '../config.js';

const atRest = (c) => c.state === 'resting' || c.state === 'sleeping';
const has = (v) => v !== null && v !== undefined;
const fmtTemp = (c) => `${c.tempC.toFixed(1)} °C / ${((c.tempC * 9) / 5 + 32).toFixed(1)} °F`;

export const RULES = [
  {
    id: 'temp-critical',
    level: 'critical',
    holdSec: 10,
    test: (c) => has(c.tempC) && c.tempC >= VITALS.tempC.critical,
    message: (c) => `Temperature ${fmtTemp(c)}: heat-stroke range. Cool the dog down and call a vet.`,
  },
  {
    id: 'temp-high',
    level: 'warning',
    holdSec: 10,
    test: (c) => has(c.tempC) && c.tempC >= VITALS.tempC.high && c.tempC < VITALS.tempC.critical,
    message: (c) => `High temperature ${fmtTemp(c)}: possible fever or overheating.`,
  },
  {
    id: 'temp-low',
    level: 'warning',
    holdSec: 10,
    test: (c) => has(c.tempC) && c.tempC <= VITALS.tempC.low,
    message: (c) => `Low temperature ${fmtTemp(c)}: keep the dog warm.`,
  },
  {
    id: 'hr-rest-high',
    level: 'warning',
    holdSec: 30,
    test: (c) => has(c.hr) && atRest(c) && c.hr > c.vitals.restingHrMax,
    message: (c) =>
      `Heart rate ${Math.round(c.hr)} bpm while resting (expected under ${c.vitals.restingHrMax}). Possible pain, stress or heat.`,
  },
  {
    id: 'hr-max',
    level: 'warning',
    holdSec: 10,
    test: (c) => has(c.hr) && c.hr > c.vitals.maxHr,
    message: (c) => `Very high heart rate ${Math.round(c.hr)} bpm. Let the dog rest.`,
  },
  {
    id: 'resp-rest-high',
    level: 'warning',
    holdSec: 30,
    test: (c) => has(c.respBpm) && atRest(c) && c.respBpm > VITALS.respRestingMax,
    message: (c) =>
      `Breathing ${Math.round(c.respBpm)}/min at rest (vets flag above ${VITALS.respRestingMax}/min). Watch closely; call a vet if it persists.`,
  },
  {
    id: 'gait-asymmetry',
    level: 'info',
    holdSec: 0,
    test: (c) => c.gait && c.gait.symmetry < VITALS.gaitSymmetryMin,
    message: (c) =>
      `Uneven gait (symmetry ${Math.round(c.gait.symmetry * 100)}%). The dog may be favouring a leg (experimental).`,
  },
  {
    id: 'battery-low',
    level: 'info',
    holdSec: 0,
    test: (c) => has(c.battery) && c.battery <= VITALS.batteryLow,
    message: (c) => `Collar battery at ${Math.round(c.battery)}%. Charge it soon.`,
  },
  {
    id: 'signal-lost',
    level: 'warning',
    holdSec: 0,
    test: (c) => c.connected && c.lastSampleAt > 0 && c.now - c.lastSampleAt > ANALYSIS.signalLostSec * 1000,
    message: () => 'No data from the collar. Is it in range and switched on?',
  },
];

export class AlertEngine {
  constructor(rules = RULES) {
    this.rules = rules;
    this.since = new Map(); // rule id → when the condition first held
    this.active = new Map(); // rule id → alert
  }

  // ctx: { now, state, hr, tempC, respBpm, battery, vitals, gait, connected, lastSampleAt }
  evaluate(ctx) {
    const raised = [];
    for (const rule of this.rules) {
      if (!rule.test(ctx)) {
        this.since.delete(rule.id);
        this.active.delete(rule.id);
        continue;
      }
      if (!this.since.has(rule.id)) this.since.set(rule.id, ctx.now);
      if (ctx.now - this.since.get(rule.id) < rule.holdSec * 1000) continue;
      const existing = this.active.get(rule.id);
      const alert = { id: rule.id, level: rule.level, message: rule.message(ctx), since: existing?.since ?? ctx.now };
      if (!existing) raised.push(alert);
      this.active.set(rule.id, alert);
    }
    return { active: [...this.active.values()], raised };
  }

  reset() {
    this.since.clear();
    this.active.clear();
  }
}
