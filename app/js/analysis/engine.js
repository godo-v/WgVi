// AnalysisEngine: runs once a second. It takes the latest window from the
// SensorHub, classifies the activity, learns the dog's resting heart rate,
// updates gait metrics and alerts, and keeps today's time-per-activity.

import { ANALYSIS, VITALS } from '../config.js';
import { Emitter, todayKey } from '../util.js';
import { accelFeatures } from './features.js';
import { ActivityClassifier } from './activity.js';
import { GaitAnalyzer } from './gait.js';
import { AlertEngine } from './alerts.js';
import { vitalsFor, DEFAULT_PROFILE } from './profile.js';

export class AnalysisEngine extends Emitter {
  constructor({ hub, getProfile = () => DEFAULT_PROFILE, totals = null }) {
    super();
    this.hub = hub;
    this.getProfile = getProfile;
    this.classifier = new ActivityClassifier();
    this.gait = new GaitAnalyzer();
    this.alerts = new AlertEngine();
    this.learnedRestingHr = null;
    this.restSince = null;
    this.totals = totals?.date === todayKey() ? totals : emptyTotals();
    this.last = null;
  }

  restingHr() {
    return this.learnedRestingHr ?? vitalsFor(this.getProfile()).restingHr;
  }

  tick(now = Date.now(), { connected = true } = {}) {
    const vitals = vitalsFor(this.getProfile());
    const hub = this.hub;
    const hr = hub.freshHeartRate(now);
    // Simulated heart rate is for display and alerts only: activity and the
    // learned resting baseline come from real measurements.
    const measuredHr = hub.latest.hr?.simulated ? null : hr;
    const window = hub.accelWindow(ANALYSIS.windowSec);
    const accelFresh = window.length && now - window[window.length - 1].at < 2000;
    const features = accelFresh ? accelFeatures(window, { defaultHz: ANALYSIS.defaultSampleHz }) : null;

    let activity = null;
    if (features && features.spanSec >= ANALYSIS.windowSec * 0.75) {
      activity = this.classifier.update({ features, hr: measuredHr, restingHr: this.restingHr(), now });
      this.#learnRestingHr(activity.state, measuredHr, vitals, now);
      this.gait.update(features, activity.state);
      this.#count(activity.state, now);
    }

    const temp = hub.fresh('temp', now);
    const resp = hub.fresh('resp', now);
    const battery = hub.latest.battery;
    const gait = this.gait.summary();
    const alerts = this.alerts.evaluate({
      now,
      state: activity?.state ?? null,
      hr,
      tempC: temp ? temp.celsius + VITALS.tempOffsetC : null,
      respBpm: resp?.bpm ?? null,
      battery: battery?.percent ?? null,
      vitals,
      gait,
      connected,
      lastSampleAt: hub.lastSampleAt,
    });

    this.last = { now, activity, features, hr, restingHr: this.restingHr(), vitals, gait, alerts, totals: this.totals };
    this.emit('update', this.last);
    return this.last;
  }

  // Learn this dog's own resting heart rate, starting from the typical value
  // for its size. Only readings after a minute of continuous rest count (the
  // heart needs time to recover after exercise), and readings above the
  // normal resting range are ignored so a stressed dog doesn't teach the app
  // that a racing heart is normal.
  #learnRestingHr(state, hr, vitals, now) {
    if (state !== 'resting' && state !== 'sleeping') {
      this.restSince = null;
      return;
    }
    this.restSince ??= now;
    if (!hr || now - this.restSince < ANALYSIS.restingHrSettleSec * 1000 || hr > vitals.restingHrMax) return;
    const current = this.learnedRestingHr ?? vitals.restingHr;
    this.learnedRestingHr = current + ANALYSIS.learnRestingHrRate * (hr - current);
  }

  // Call when the dog profile changes (a different dog has different norms).
  resetBaseline() {
    this.learnedRestingHr = null;
  }

  #count(state, now) {
    const day = todayKey(new Date(now));
    if (this.totals.date !== day) this.totals = emptyTotals(day);
    this.totals.seconds[state] = (this.totals.seconds[state] ?? 0) + ANALYSIS.hopSec;
  }

  reset() {
    this.restSince = null;
    this.classifier.reset();
    this.gait.reset();
    this.alerts.reset();
  }
}

function emptyTotals(date = todayKey()) {
  return { date, seconds: {} };
}
