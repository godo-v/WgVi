// Cloud sync. Raw sensor data (25+ readings per second) stays on the device;
// only one small summary per minute is uploaded. That keeps bandwidth, storage
// and therefore cloud-credit usage low (about 1,440 tiny records per dog per
// day).
//
// The endpoint is any HTTPS service implementing POST /v1/summaries; the
// reference server in /cloud deploys to Google Cloud Run, Azure or AWS with
// student credits. Summaries are queued while offline and retried.

import { CLOUD } from '../config.js';
import { Emitter } from '../util.js';

export class MinuteSummarizer {
  constructor(periodSec = CLOUD.summaryPeriodSec) {
    this.periodMs = periodSec * 1000;
    this.#reset(null);
  }

  // Feed every engine update; returns the previous minute's summary when a
  // new minute starts, otherwise null.
  add(update, hub) {
    const now = update.now;
    let summary = null;
    if (this.start !== null && now - this.start >= this.periodMs) {
      summary = this.#build(now);
      this.#reset(now);
    }
    if (this.start === null) this.#reset(now);
    const s = update.activity?.state;
    if (s) this.seconds[s] = (this.seconds[s] ?? 0) + 1;
    if (update.hr) this.hr.push(update.hr);
    const temp = hub.fresh('temp', now);
    const resp = hub.fresh('resp', now);
    if (temp) this.temp.push(temp.celsius);
    if (resp) this.resp.push(resp.bpm);
    for (const a of update.alerts.raised) this.alerts.add(a.id);
    this.battery = hub.latest.battery?.percent ?? this.battery;
    this.gait = update.gait ?? this.gait;
    this.restingHr = update.restingHr;
    return summary;
  }

  #build(now) {
    return {
      periodStart: new Date(this.start).toISOString(),
      periodEnd: new Date(now).toISOString(),
      activitySeconds: this.seconds,
      heartRate: stats(this.hr),
      restingHr: Math.round(this.restingHr),
      temperatureC: stats(this.temp, 2),
      breathingRate: stats(this.resp),
      battery: this.battery ?? null,
      gait: this.gait && {
        symmetry: round(this.gait.symmetry, 3),
        regularity: round(this.gait.regularity, 3),
        cadenceHz: round(this.gait.cadenceHz, 2),
      },
      alerts: [...this.alerts],
    };
  }

  #reset(now) {
    this.start = now;
    this.seconds = {};
    this.hr = [];
    this.temp = [];
    this.resp = [];
    this.alerts = new Set();
    this.gait = null;
  }
}

const round = (x, digits = 0) => Math.round(x * 10 ** digits) / 10 ** digits;

function stats(values, digits = 0) {
  if (!values.length) return null;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return { avg: round(avg, digits), min: round(Math.min(...values), digits), max: round(Math.max(...values), digits) };
}

export class CloudSync extends Emitter {
  constructor({ storage, fetchImpl = (...args) => globalThis.fetch(...args) }) {
    super();
    this.storage = storage;
    this.fetch = fetchImpl;
    this.queue = storage.get('cloudQueue', []);
    this.settings = { enabled: false, endpoint: '', apiKey: '', deviceId: '' };
    this.status = { lastSyncAt: null, error: null };
    this.busy = false;
  }

  configure(settings) {
    this.settings = { ...this.settings, ...settings };
    this.#notify();
  }

  get pending() {
    return this.queue.length;
  }

  enqueue(summary, dogName) {
    this.queue.push({ ...summary, dogName });
    if (this.queue.length > CLOUD.maxQueued) this.queue.splice(0, this.queue.length - CLOUD.maxQueued);
    this.storage.set('cloudQueue', this.queue);
    this.#notify();
  }

  async flush() {
    const { enabled, endpoint, apiKey, deviceId } = this.settings;
    if (!enabled || !endpoint || this.busy || !this.queue.length) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const batch = this.queue.slice(0, CLOUD.batchSize);
        const res = await this.fetch(`${endpoint.replace(/\/+$/, '')}/v1/summaries`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ deviceId, summaries: batch }),
        });
        if (!res.ok) throw new Error(`Server answered ${res.status}`);
        this.queue.splice(0, batch.length);
        this.storage.set('cloudQueue', this.queue);
      }
      this.status = { lastSyncAt: Date.now(), error: null };
    } catch (err) {
      this.status = { ...this.status, error: err.message || String(err) };
    } finally {
      this.busy = false;
      this.#notify();
    }
  }

  #notify() {
    this.emit('status', { ...this.status, pending: this.pending, enabled: this.settings.enabled });
  }
}
