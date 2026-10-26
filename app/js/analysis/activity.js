// Activity classifier: fuses accelerometer features with heart rate.
//
// 1. The accelerometer proposes: each activity gets a 0..1 score from how
//    much (VeDBA), how rhythmically (periodicity, cadence) and how
//    stop-and-go (burstiness) the dog moves.
// 2. Heart rate confirms: each score is scaled by how well the current heart
//    rate (as a multiple of the dog's resting HR) fits that activity. With
//    hrWeight = 0.5 a poor HR fit halves a score, but heart rate alone can
//    never invent an activity the accelerometer doesn't see. HR also lags
//    movement by 10-30 s, which is another reason it only re-weights.
// 3. Scores are smoothed over time so the label doesn't flicker.
// 4. Sleep = long, still rest with the heart at or below its resting rate.
//
// Without a usable heart rate (no sensor contact, motion artefacts) the
// classifier falls back to the accelerometer alone.

import { ACTIVITY_THRESHOLDS as T, ANALYSIS } from '../config.js';

export const CLASSES = ['resting', 'light', 'walking', 'running', 'playing'];

const up = (x, a, b) => (x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a));
const down = (x, a, b) => 1 - up(x, a, b);
const trap = (x, [a, b, c, d]) => Math.min(up(x, a, b), down(x, c, d));

export function accelScores(f) {
  const rhythm = up(f.periodicity, ...T.rhythmic);
  const irregular = down(f.periodicity, ...T.irregular);
  const unsteady = up(f.burstiness, ...T.unsteady);
  const locomotion = rhythm * (1 - unsteady); // gaits are rhythmic AND sustained
  return {
    resting: down(f.vedba, ...T.rest),
    light: trap(f.vedba, T.light) * (1 - 0.6 * rhythm),
    walking: trap(f.vedba, T.walk) * locomotion * (0.6 + 0.4 * trap(f.cadenceHz, T.walkCadenceHz)),
    running: up(f.vedba, ...T.run) * locomotion * (0.6 + 0.4 * up(f.cadenceHz, ...T.runCadenceHz)),
    playing: up(f.vedba, ...T.play) * Math.max(irregular, unsteady),
  };
}

export function heartRateScores(ratio) {
  return {
    resting: down(ratio, ...T.hrRest),
    light: trap(ratio, T.hrLight),
    walking: trap(ratio, T.hrWalk),
    running: up(ratio, ...T.hrRun),
    playing: up(ratio, ...T.hrPlay),
  };
}

export class ActivityClassifier {
  constructor(options = {}) {
    this.options = { ...ANALYSIS, ...options };
    this.reset();
  }

  reset() {
    this.smoothed = null;
    this.stillSince = null;
    this.sleeping = false;
  }

  // features: from accelFeatures(); hr: bpm or null; restingHr: bpm; now: ms
  update({ features: f, hr = null, restingHr, now }) {
    const { hrWeight, smoothing } = this.options;
    const accel = accelScores(f);
    const ratio = hr && restingHr ? hr / restingHr : null;
    const heart = ratio ? heartRateScores(ratio) : null;

    const fused = {};
    for (const c of CLASSES) fused[c] = heart ? accel[c] * (1 - hrWeight + hrWeight * heart[c]) : accel[c];
    if (CLASSES.every((c) => fused[c] < 1e-3)) fused.light = 1e-3; // nothing fits: some movement

    if (!this.smoothed) this.smoothed = { ...fused };
    else for (const c of CLASSES) this.smoothed[c] = smoothing * fused[c] + (1 - smoothing) * this.smoothed[c];

    let state = CLASSES.reduce((best, c) => (this.smoothed[c] > this.smoothed[best] ? c : best), CLASSES[0]);
    const total = CLASSES.reduce((sum, c) => sum + this.smoothed[c], 0);
    const confidence = this.smoothed[state] / total;

    state = this.#sleepCheck(state, f, ratio, now);
    return { state, confidence, scores: { ...this.smoothed }, accel, heart, hrRatio: ratio, usedHr: Boolean(heart) };
  }

  #sleepCheck(state, f, ratio, now) {
    const { sleepAfterSec, sleepStillVedba } = this.options;
    if (state !== 'resting') {
      this.stillSince = null;
      this.sleeping = false;
      return state;
    }
    // Once asleep, small twitches don't wake the dog up; a racing heart does.
    const calm = ratio === null || ratio <= 1.05;
    if (this.sleeping) {
      this.sleeping = f.vedba < 2 * sleepStillVedba && (ratio === null || ratio <= 1.15);
    } else if (f.vedba < sleepStillVedba && calm) {
      this.stillSince ??= now;
      this.sleeping = now - this.stillSince >= sleepAfterSec * 1000;
    } else {
      this.stillSince = null;
    }
    if (!this.sleeping) return 'resting';
    this.stillSince = null;
    return 'sleeping';
  }
}

// A human-readable explanation of the decision, shown under the activity.
export function explain(result, f) {
  const parts = [
    `movement ${f.vedba.toFixed(2)} g`,
    `rhythm ${Math.round(f.periodicity * 100)}%`,
    f.cadenceHz ? `${f.cadenceHz.toFixed(1)} Hz` : 'no steady rhythm',
  ];
  parts.push(result.usedHr ? `heart ${result.hrRatio.toFixed(2)}× resting` : 'no heart-rate signal: accelerometer only');
  return parts.join(' · ');
}
