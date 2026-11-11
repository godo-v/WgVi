// SensorHub: one place that holds every reading from the collar, whatever
// transport it came from. Analysis code and the UI read from here.

import { ANALYSIS } from '../config.js';
import { Emitter } from '../util.js';

const ACCEL_KEEP_SEC = 30;
const HR_KEEP_SEC = 600;

export class SensorHub extends Emitter {
  accel = []; // {t (device ms), at (wall ms), x, y, z} in g
  gyro = [];
  hrHistory = []; // {at, bpm, quality}
  latest = {}; // newest sample of each type
  lastSampleAt = 0; // last reading from the collar (simulated vitals don't count)
  counts = {};

  ingest(sample) {
    const at = sample.at ?? Date.now();
    const s = { ...sample, at };
    if (!s.simulated) this.lastSampleAt = at;
    this.latest[s.type] = s;
    this.counts[s.type] = (this.counts[s.type] ?? 0) + 1;

    if (s.type === 'accel' || s.type === 'gyro') {
      const buf = this[s.type];
      const prev = buf[buf.length - 1];
      if (s.t == null) s.t = at;
      if (prev && s.t < prev.t - 1000) buf.length = 0; // collar rebooted: clock restarted
      buf.push(s);
      const cutoff = s.t - ACCEL_KEEP_SEC * 1000;
      if (buf[0].t < cutoff) buf.splice(0, buf.findIndex((p) => p.t >= cutoff));
    } else if (s.type === 'hr') {
      this.hrHistory.push(s);
      const cutoff = at - HR_KEEP_SEC * 1000;
      if (this.hrHistory[0].at < cutoff) this.hrHistory.splice(0, this.hrHistory.findIndex((p) => p.at >= cutoff));
    }
    this.emit('sample', s);
    return s;
  }

  // Accelerometer samples covering the last `seconds` of collar time.
  accelWindow(seconds) {
    const buf = this.accel;
    if (!buf.length) return [];
    const from = buf[buf.length - 1].t - seconds * 1000;
    let i = buf.length - 1;
    while (i > 0 && buf[i - 1].t >= from) i--;
    return buf.slice(i);
  }

  // The latest heart rate if it is recent and the sensor trusted it.
  freshHeartRate(now = Date.now()) {
    const hr = this.latest.hr;
    if (!hr || now - hr.at > ANALYSIS.hrMaxAgeSec * 1000 || hr.quality < ANALYSIS.hrMinQuality) return null;
    return hr.bpm;
  }

  fresh(type, now = Date.now(), maxAgeSec = ANALYSIS.staleVitalSec) {
    const s = this.latest[type];
    return s && now - s.at <= maxAgeSec * 1000 ? s : null;
  }

  // Forget one kind of reading, e.g. when its simulation is switched off.
  clear(type) {
    delete this.latest[type];
    if (type === 'hr') this.hrHistory = [];
  }

  reset() {
    this.accel = [];
    this.gyro = [];
    this.hrHistory = [];
    this.latest = {};
    this.lastSampleAt = 0;
    this.counts = {};
  }
}
