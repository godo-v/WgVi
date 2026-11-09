// Simulated WagVitals collar. It produces the exact same text protocol as the
// nRF52840 firmware (docs/BLE_PROTOCOL.md) and pushes it through the same
// parser, so the whole pipeline can be developed and tested before the
// hardware is ready.

import { Emitter, mulberry32, gaussian } from '../util.js';
import { parseLine } from './protocol.js';

export const SCENARIOS = {
  auto: 'Auto tour (cycles activities)',
  resting: 'Resting',
  sleeping: 'Sleeping',
  light: 'Light activity (sniffing)',
  walking: 'Walking',
  running: 'Running',
  playing: 'Playing',
  limping: 'Walking with a limp',
  fever: 'Fever (resting, high temperature)',
  stress: 'Stress (resting, racing heart)',
};

const AUTO_TOUR = [
  ['resting', 25],
  ['walking', 40],
  ['running', 25],
  ['playing', 35],
  ['walking', 20],
  ['light', 20],
];
const AUTO_LENGTH = AUTO_TOUR.reduce((sum, [, sec]) => sum + sec, 0);

// Heart rate (× resting HR), temperature (°C) and breathing (/min) per behaviour.
const BEHAVIOUR = {
  sleeping: { hr: 0.88, temp: 38.4, resp: 16 },
  resting: { hr: 1.0, temp: 38.6, resp: 22 },
  light: { hr: 1.15, temp: 38.7, resp: 28 },
  walking: { hr: 1.4, temp: 38.9, resp: 40 },
  running: { hr: 2.0, temp: 39.2, resp: 120 },
  playing: { hr: 1.75, temp: 39.1, resp: 90 },
};

// Gravity direction in the collar frame: standing vs lying down.
const UPRIGHT = [0.05, -0.98, 0.18];
const LYING = [0.55, -0.8, 0.22];

function scenarioState(scenario, elapsedSec) {
  switch (scenario) {
    case 'auto': {
      let t = elapsedSec % AUTO_LENGTH;
      for (const [behaviour, sec] of AUTO_TOUR) {
        if (t < sec) return { behaviour };
        t -= sec;
      }
      return { behaviour: 'resting' };
    }
    case 'limping':
      return { behaviour: 'walking', asymmetry: 0.45 };
    case 'fever':
      return { behaviour: 'resting', temp: 40.1 };
    case 'stress':
      return { behaviour: 'resting', hr: 1.65, resp: 36 };
    default:
      return { behaviour: BEHAVIOUR[scenario] ? scenario : 'resting' };
  }
}

// Protocol lines an accelerometer-only collar still sends: accelerometer,
// gyroscope, battery and info. Heart rate (H), temperature (T) and breathing
// (R) are left out.
const ACCEL_ONLY_TYPES = new Set(['A', 'G', 'B', 'I']);

// Deterministic signal model: step(ms) returns the protocol lines the collar
// would have sent during that time. With accelOnly it behaves like a collar
// that has only the accelerometer: the movement signal is identical, the
// other sensors stay silent.
export class CollarModel {
  constructor({ seed = 42, scenario = 'auto', sampleHz = 25, restingHr = 85, accelOnly = false } = {}) {
    this.rand = mulberry32(seed);
    this.sampleHz = sampleHz;
    this.restingHr = restingHr;
    this.accelOnly = accelOnly;
    this.t = 0; // device clock (ms) of the last generated sample
    this.clock = 0; // device clock (ms) we have been asked to reach
    this.scenario = scenario;
    this.scenarioStart = 0;
    this.hr = restingHr;
    this.temp = 38.6;
    this.resp = 22;
    this.battery = 92;
    this.phase = 0;
    this.ar = [0, 0, 0];
    this.event = null;
    this.nextEventAt = 0;
    this.twitchUntil = -1;
    this.next = { hr: 0, slow: 0, battery: 0 };
    this.sentInfo = false;
  }

  setScenario(scenario) {
    this.scenario = scenario;
    this.scenarioStart = this.t;
  }

  current() {
    return scenarioState(this.scenario, (this.t - this.scenarioStart) / 1000);
  }

  step(ms) {
    const lines = [];
    const dt = 1000 / this.sampleHz;
    this.clock += ms;
    if (!this.sentInfo) {
      lines.push(`I,0,fw=simulator,hz=${this.sampleHz}`);
      this.sentInfo = true;
    }
    while (this.t + dt <= this.clock) {
      this.t += dt;
      const t = Math.round(this.t);
      const state = this.current();
      this.#updateVitals(state, dt / 1000);
      const [x, y, z] = this.#accel(state, dt / 1000).map((g) => Math.round(g * 1000));
      lines.push(`A,${t},${x},${y},${z}`);
      if (this.t >= this.next.hr) {
        lines.push(this.#heartRateLine(state, t));
        this.next.hr += 1000;
      }
      if (this.t >= this.next.slow) {
        lines.push(`T,${t},${(this.temp + 0.05 * gaussian(this.rand)).toFixed(2)}`);
        lines.push(`R,${t},${Math.round(this.resp + gaussian(this.rand))}`);
        this.next.slow += 5000;
      }
      if (this.t >= this.next.battery) {
        lines.push(`B,${t},${Math.round(this.battery)}`);
        this.next.battery += 30000;
      }
    }
    return this.accelOnly ? lines.filter((line) => ACCEL_ONLY_TYPES.has(line[0])) : lines;
  }

  #updateVitals(state, dt) {
    const base = BEHAVIOUR[state.behaviour];
    const hrTarget = this.restingHr * (state.hr ?? base.hr);
    // Heart rate lags behind movement: rises in ~12 s, recovers in ~25 s.
    this.hr += (hrTarget - this.hr) * Math.min(1, dt / (hrTarget > this.hr ? 12 : 25));
    this.temp += ((state.temp ?? base.temp) - this.temp) * Math.min(1, dt / 20);
    this.resp += ((state.resp ?? base.resp) - this.resp) * Math.min(1, dt / 8);
    this.battery = Math.max(0, this.battery - dt / 120);
  }

  #heartRateLine(state, t) {
    const r = this.rand;
    const moving = state.behaviour === 'running' || state.behaviour === 'playing';
    // Optical HR sensors struggle while the dog is moving hard.
    if (state.behaviour === 'playing' && r() < 0.1) {
      return `H,${t},${Math.round(this.hr + 40 * (r() - 0.5) * 2)},${Math.round(10 + 15 * r())}`;
    }
    const resting = state.behaviour === 'resting' || state.behaviour === 'sleeping';
    const arrhythmia = resting ? 4 * Math.sin((2 * Math.PI * this.resp * this.t) / 60000) : 0;
    const quality = moving ? 45 + 30 * r() : 90 + 10 * r();
    return `H,${t},${Math.round(this.hr + arrhythmia + 2 * gaussian(r))},${Math.round(quality)}`;
  }

  #accel(state, dt) {
    const r = this.rand;
    const g = () => gaussian(r);
    const time = this.t / 1000;
    let d = [0, 0, 0]; // dynamic acceleration: [lateral, vertical, fore-aft]
    let gravity = UPRIGHT;
    let noise = 0.01;

    switch (state.behaviour) {
      case 'sleeping':
        gravity = LYING;
        noise = 0.003;
        d[1] = 0.003 * Math.sin((2 * Math.PI * this.resp * time) / 60);
        break;
      case 'resting': {
        gravity = LYING;
        noise = 0.006;
        d[1] = 0.004 * Math.sin((2 * Math.PI * this.resp * time) / 60);
        if (time > this.twitchUntil + 6 && r() < dt / 8) this.twitchUntil = time + 0.3; // head lift
        if (time < this.twitchUntil) d[0] = 0.06 * Math.sin((Math.PI * (this.twitchUntil - time)) / 0.3);
        break;
      }
      case 'light':
        d = this.#wander(0.92, 0.025);
        break;
      case 'walking':
      case 'running': {
        const running = state.behaviour === 'running';
        const f = (running ? 2.8 : 1.8) * (1 + 0.03 * Math.sin(0.2 * time));
        this.phase += 2 * Math.PI * f * dt;
        const p = this.phase;
        const a = running ? 0.75 : 0.22;
        // Head bob at step frequency + harmonic; side sway at stride frequency.
        // A limp adds a half-frequency component: left and right steps differ.
        d = [
          (running ? 0.2 : 0.08) * Math.sin(p / 2),
          a * Math.sin(p) + a * 0.32 * Math.sin(2 * p + 0.8) + (state.asymmetry ?? 0) * a * Math.sin(p / 2 + 0.3),
          (running ? 0.35 : 0.1) * Math.sin(p + 1.2),
        ];
        noise = running ? 0.07 : 0.025;
        break;
      }
      case 'playing':
        d = this.#play(time);
        noise = 0.02;
        break;
    }
    return gravity.map((gv, i) => gv + d[i] + noise * g());
  }

  // Slowly wandering movement (sniffing, shifting weight): AR(1) noise.
  #wander(keep, step) {
    this.ar = this.ar.map((v) => keep * v + step * gaussian(this.rand));
    return [...this.ar];
  }

  // Play = irregular bursts: pounces, head shakes, short sprints and pauses.
  #play(time) {
    const r = this.rand;
    if (!this.event || time >= this.event.end) {
      this.event = null;
      if (time >= this.nextEventAt) {
        const roll = r();
        const type = roll < 0.35 ? 'pounce' : roll < 0.55 ? 'shake' : roll < 0.8 ? 'sprint' : 'pause';
        const duration = { pounce: 0.3, shake: 0.6, sprint: 1.5, pause: 1 + r() }[type];
        const dir = [g3(r), g3(r), g3(r)];
        const norm = Math.hypot(...dir) || 1;
        this.event = {
          type,
          start: time,
          end: time + duration,
          dir: dir.map((v) => v / norm),
          amp: 0.8 + 0.8 * r(),
        };
        this.nextEventAt = this.event.end + 0.2 + 1.2 * r();
      }
    }
    const e = this.event;
    if (e?.type === 'pause') return [0, 0, 0];
    const base = this.#wander(0.9, 0.02);
    if (!e) return base;
    const s = time - e.start;
    if (e.type === 'pounce') {
      const k = e.amp * Math.sin((Math.PI * s) / (e.end - e.start));
      return base.map((v, i) => v + k * e.dir[i]);
    }
    if (e.type === 'shake') return [base[0] + 0.9 * Math.sin(2 * Math.PI * 6 * s), base[1], base[2]];
    const p = 2 * Math.PI * 3.2 * s; // sprint
    return [base[0] + 0.25 * Math.sin(p / 2), base[1] + 0.6 * Math.sin(p), base[2] + 0.3 * Math.sin(p + 1)];
  }
}

const g3 = (r) => r() * 2 - 1;

// Real-time wrapper exposing the same interface as WebBluetoothCollar.
export class SimulatedCollar extends Emitter {
  #timer = null;
  #last = 0;

  constructor({ scenario = 'auto', seed = Date.now() % 1e9, restingHr = 85, accelOnly = false } = {}) {
    super();
    this.model = new CollarModel({ scenario, seed, restingHr, accelOnly });
  }

  get name() {
    return 'WagVitals Simulator';
  }

  get isConnected() {
    return this.#timer !== null;
  }

  setScenario(scenario) {
    this.model.setScenario(scenario);
    this.emit('line', `> SIM ${scenario}`);
  }

  setAccelOnly(accelOnly) {
    if (this.model.accelOnly === accelOnly) return;
    this.model.accelOnly = accelOnly;
    this.emit('line', `> SIM ${accelOnly ? 'accelerometer only' : 'all sensors'}`);
  }

  async connect() {
    this.#last = performance.now();
    this.#timer = setInterval(() => this.#pump(), 100);
    this.emit('status', { state: 'connected', message: `Connected to ${this.name}` });
  }

  async disconnect() {
    clearInterval(this.#timer);
    this.#timer = null;
    this.emit('status', { state: 'disconnected', message: 'Simulator stopped' });
  }

  async send(command) {
    this.emit('line', `> ${command}`);
  }

  #pump() {
    const now = performance.now();
    const ms = Math.min(1000, now - this.#last); // don't flood after a sleeping tab wakes up
    this.#last = now;
    for (const line of this.model.step(ms)) {
      this.emit('line', line);
      const sample = parseLine(line);
      if (sample) this.emit('sample', sample);
    }
  }
}
