// App entry point: wires the collar transports, analysis engine, cloud sync
// and recorder to the page.

import { ACTIVITIES, ANALYSIS, VITALS } from './config.js';
import { createStorage } from './util.js';
import { WebBluetoothCollar, bluetoothSupport } from './ble/webBluetooth.js';
import { SimulatedCollar, SCENARIOS } from './ble/simulator.js';
import { SensorHub } from './analysis/hub.js';
import { AnalysisEngine } from './analysis/engine.js';
import { CLASSES, explain } from './analysis/activity.js';
import { DEFAULT_PROFILE, vitalsFor, activityGoal } from './analysis/profile.js';
import { CloudSync, MinuteSummarizer } from './cloud/cloudSync.js';
import { Recorder } from './recorder.js';
import { drawLines } from './ui/charts.js';

const $ = (id) => document.getElementById(id);
const storage = createStorage();
const desktop = window.wagvitalsDesktop; // set by the Electron preload script

let profile = { ...DEFAULT_PROFILE, ...storage.get('profile', {}) };
let settings = {
  fahrenheit: false,
  showAllDevices: false,
  cloudEnabled: false,
  endpoint: '',
  apiKey: '',
  ...storage.get('settings', {}),
};
if (!settings.deviceId) {
  settings.deviceId = crypto.randomUUID?.() ?? `dev-${Date.now()}`;
  storage.set('settings', settings);
}

const hub = new SensorHub();
const engine = new AnalysisEngine({ hub, getProfile: () => profile, totals: storage.get('totals', null) });
const recorder = new Recorder();
const summarizer = new MinuteSummarizer();
const cloud = new CloudSync({ storage });
const logLines = [];
let collar = null;
let pickerActive = false;
let ticks = 0;

// ---------- Collar connection ----------

function attach(transport) {
  collar = transport;
  transport.on('sample', (sample) => {
    if (transport !== collar) return;
    const s = hub.ingest(sample);
    recorder.addSample(s);
    if (s.type === 'weight') {
      profile = { ...profile, weightKg: Math.round(s.kg * 10) / 10, weightSource: 'collar / smart bed' };
      storage.set('profile', profile);
    }
  });
  transport.on('line', (line) => transport === collar && addLog(line));
  transport.on('status', ({ state, message }) => {
    if (transport === collar || collar === null) setStatus(state, message);
    updateButtons();
  });
}

async function stopCollar() {
  const old = collar;
  collar = null;
  if (old) await old.disconnect().catch(() => {});
  hub.reset();
  engine.reset();
  updateButtons();
}

async function connectBluetooth() {
  await stopCollar();
  const ble = new WebBluetoothCollar();
  attach(ble);
  setStatus('connecting', 'Looking for collars…');
  pickerActive = true;
  try {
    await ble.connect({ acceptAllDevices: settings.showAllDevices });
  } catch (err) {
    collar = null;
    setStatus('error', friendlyError(err));
  } finally {
    pickerActive = false;
    if ($('device-picker').open) $('device-picker').close();
    updateButtons();
  }
}

async function startSimulator() {
  if (collar instanceof SimulatedCollar) {
    collar.setScenario($('sim-scenario').value);
    return;
  }
  await stopCollar();
  const sim = new SimulatedCollar({ scenario: $('sim-scenario').value, restingHr: vitalsFor(profile).restingHr });
  attach(sim);
  await sim.connect();
  updateButtons();
}

function friendlyError(err) {
  if (err?.name === 'NotFoundError') return 'No collar selected.';
  if (err?.name === 'NetworkError') return 'Could not connect. Move closer to the collar and try again.';
  if (err?.name === 'SecurityError') return 'Bluetooth access was blocked.';
  return err?.message || String(err);
}

function setStatus(state, message) {
  $('status').dataset.state = state;
  $('status-text').textContent = message;
}

function updateButtons() {
  const connected = Boolean(collar);
  $('btn-disconnect').hidden = !connected;
  $('btn-sim').textContent = collar instanceof SimulatedCollar ? 'Switch' : 'Simulate';
}

// In the desktop app Electron hands us the list of discovered devices and we
// show our own picker (browsers show a built-in one instead).
desktop?.onBluetoothDevices((devices) => {
  if (!pickerActive) return;
  const dialog = $('device-picker');
  $('device-list').replaceChildren(
    ...devices.map((d) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.textContent = d.name || `Unnamed device (${d.id})`;
      button.onclick = () => chooseDevice(d.id);
      li.append(button);
      return li;
    }),
  );
  if (!dialog.open) dialog.showModal();
});

function chooseDevice(id) {
  pickerActive = false;
  desktop?.selectBluetoothDevice(id);
  if ($('device-picker').open) $('device-picker').close();
}

$('btn-picker-cancel').onclick = () => chooseDevice('');
$('device-picker').addEventListener('cancel', () => chooseDevice(''));

$('btn-connect').onclick = connectBluetooth;
$('btn-sim').onclick = startSimulator;
$('btn-disconnect').onclick = async () => {
  await stopCollar();
  setStatus('disconnected', 'Disconnected');
};
for (const [value, label] of Object.entries(SCENARIOS)) $('sim-scenario').add(new Option(label, value));
$('sim-scenario').onchange = () => collar instanceof SimulatedCollar && collar.setScenario($('sim-scenario').value);

const support = bluetoothSupport();
if (!support.ok) {
  $('banner').textContent = `${support.reason} The simulator still works.`;
  $('banner').hidden = false;
}

// ---------- Analysis loop ----------

setInterval(() => {
  const connected = Boolean(collar?.isConnected);
  const update = engine.tick(Date.now(), { connected });
  recorder.addActivity(update);
  if (connected && hub.lastSampleAt) {
    const summary = summarizer.add(update, hub);
    if (summary) {
      cloud.enqueue(summary, profile.name);
      cloud.flush();
    }
  }
  if (++ticks % 10 === 0) storage.set('totals', update.totals);
  render(update);
}, ANALYSIS.hopSec * 1000);

cloud.on('status', renderCloud);
cloud.configure(cloudSettings());
setInterval(() => cloud.flush(), 5 * 60 * 1000); // retry anything queued while offline

// ---------- Rendering ----------

function render(u) {
  renderActivity(u);
  renderVitals(u);
  renderToday(u.totals);
  renderGait(u.gait);
  renderAlerts(u.alerts.active);
  renderCollar(u);
  if (recorder.recording) $('rec-status').textContent = `Recording… ${recorder.rows.length.toLocaleString()} rows`;
}

function renderActivity(u) {
  $('dog-name').textContent = `${profile.name || 'Dog'}: activity`;
  const a = u.activity;
  if (!a) {
    $('act-icon').textContent = '·';
    $('act-label').textContent = collar ? 'Waiting for movement data' : 'Not connected';
    $('act-confidence').textContent = collar ? 'Collecting a few seconds of accelerometer data…' : 'Connect the collar or start the simulator.';
    $('act-reason').textContent = '';
    $('act-scores').replaceChildren();
    return;
  }
  const meta = ACTIVITIES[a.state];
  $('act-icon').textContent = meta.icon;
  $('act-label').textContent = meta.label;
  $('act-confidence').textContent = `${Math.round(a.confidence * 100)}% confident`;
  $('act-reason').textContent = explain(a, u.features);
  const total = CLASSES.reduce((sum, c) => sum + a.scores[c], 0) || 1;
  const top = CLASSES.reduce((best, c) => (a.scores[c] > a.scores[best] ? c : best));
  renderBars(
    $('act-scores'),
    CLASSES.map((c) => ({ label: ACTIVITIES[c].label, frac: a.scores[c] / total, text: `${Math.round((a.scores[c] / total) * 100)}%`, top: c === top })),
  );
}

function renderBars(el, rows) {
  el.replaceChildren(
    ...rows.flatMap((r) => {
      const label = document.createElement('span');
      label.textContent = r.label;
      label.className = r.top ? 'top' : '';
      const track = document.createElement('span');
      track.className = 'track';
      const fill = document.createElement('span');
      fill.className = 'fill';
      fill.style.width = `${Math.round(Math.min(1, r.frac) * 100)}%`;
      track.append(fill);
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = r.text;
      return [label, track, val];
    }),
  );
}

function renderVitals(u) {
  const now = u.now;
  const hrSample = hub.latest.hr;
  const hrRecent = hrSample && now - hrSample.at < ANALYSIS.hrMaxAgeSec * 1000;
  $('hr-value').textContent = u.hr ? Math.round(u.hr) : '—';
  $('hr-sub').textContent = hrRecent && !u.hr
    ? 'Poor sensor contact (dog moving?)'
    : `Resting baseline ${Math.round(u.restingHr)} bpm · normal at rest under ${u.vitals.restingHrMax}`;
  const hrPoints = hub.hrHistory.filter((h) => h.quality >= ANALYSIS.hrMinQuality && now - h.at < 300_000).map((h) => [h.at, h.bpm]);
  drawLines($('hr-chart'), [{ points: hrPoints, color: '--line' }]);

  const temp = hub.fresh('temp', now);
  const t = VITALS.tempC;
  $('temp-unit').textContent = settings.fahrenheit ? '°F' : '°C';
  $('temp-value').textContent = temp ? formatTemp(temp.celsius + VITALS.tempOffsetC) : '—';
  $('temp-sub').textContent = `Normal ${formatTemp(t.normalLow)}–${formatTemp(t.normalHigh)} ${settings.fahrenheit ? '°F' : '°C'}`;

  const resp = hub.fresh('resp', now);
  $('resp-value').textContent = resp ? Math.round(resp.bpm) : '—';
  const resting = u.activity?.state === 'resting' || u.activity?.state === 'sleeping';
  $('resp-sub').textContent = resting
    ? `At rest: normally under ${VITALS.respRestingMax}/min`
    : 'Fast breathing and panting are normal during exercise';
}

function formatTemp(celsius) {
  return settings.fahrenheit ? ((celsius * 9) / 5 + 32).toFixed(1) : celsius.toFixed(1);
}

function renderToday(totals) {
  const sec = totals.seconds;
  const activeMin = Object.keys(ACTIVITIES)
    .filter((k) => ACTIVITIES[k].active)
    .reduce((sum, k) => sum + (sec[k] ?? 0), 0) / 60;
  const goal = activityGoal(profile);
  $('goal-text').textContent = `${Math.floor(activeMin)} / ${goal.minutes} active min`;
  $('goal-bar').style.width = `${Math.min(100, (activeMin / goal.minutes) * 100)}%`;
  const maxSec = Math.max(60, ...Object.values(sec));
  renderBars(
    $('today-bars'),
    Object.entries(ACTIVITIES).map(([k, meta]) => ({ label: meta.label, frac: (sec[k] ?? 0) / maxSec, text: `${Math.round((sec[k] ?? 0) / 60)} min` })),
  );
  $('today-tip').textContent = goal.tips.join(' ') || 'Active minutes = walking + running + playing.';
}

function renderGait(g) {
  $('gait-sym').textContent = g ? `${Math.round(g.symmetry * 100)}%` : '—';
  $('gait-reg').textContent = g ? `${Math.round(g.regularity * 100)}%` : '—';
  $('gait-cad').textContent = g ? `${g.cadenceHz.toFixed(1)} steps/s` : '—';
}

function renderAlerts(active) {
  const items = active.map((a) => {
    const li = document.createElement('li');
    li.className = a.level;
    li.textContent = a.message;
    return li;
  });
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No alerts';
    items.push(li);
  }
  $('alerts').replaceChildren(...items);
}

function renderCollar(u) {
  const battery = hub.latest.battery;
  $('col-battery').textContent = battery ? `${Math.round(battery.percent)}%` : '—';
  $('col-weight').textContent = `${profile.weightKg} kg (${profile.weightSource || 'entered'})`;
  $('col-rate').textContent = u.features ? `${u.features.fs.toFixed(0)} Hz` : '—';
  $('col-fw').textContent = hub.latest.info?.text || '—';
}

function renderCloud(s) {
  let text = 'Off';
  if (s.enabled) {
    if (s.error) text = `Error: ${s.error} (${s.pending} queued)`;
    else if (s.lastSyncAt) text = `Synced ${new Date(s.lastSyncAt).toLocaleTimeString()} (${s.pending} queued)`;
    else text = `On (${s.pending} queued)`;
  }
  $('col-cloud').textContent = text;
}

// Accelerometer chart redraws ~10×/s for a live feel.
let lastChart = 0;
function chartLoop(ts) {
  if (ts - lastChart > 100) {
    lastChart = ts;
    const buf = hub.accel;
    const from = buf.length ? buf[buf.length - 1].t - 10_000 : 0;
    const win = buf.filter((s) => s.t >= from);
    drawLines(
      $('accel-chart'),
      ['x', 'y', 'z'].map((k) => ({ points: win.map((s) => [s.t, s[k]]), color: `--${k}` })),
      { min: -2, max: 2 },
    );
    const f = engine.last?.features;
    $('accel-sub').textContent = f ? `movement ${f.vedba.toFixed(3)} g` : '';
  }
  requestAnimationFrame(chartLoop);
}
requestAnimationFrame(chartLoop);

// ---------- Bluetooth log ----------

let logDirty = false;
function addLog(line) {
  logLines.push(line);
  if (logLines.length > 300) logLines.splice(0, logLines.length - 300);
  logDirty = true;
}
setInterval(() => {
  if (!logDirty || !$('log-details').open) return;
  logDirty = false;
  const el = $('log');
  el.textContent = logLines.join('\n');
  el.scrollTop = el.scrollHeight;
}, 500);

// ---------- Recording ----------

$('rec-label').onchange = () => recorder.setLabel($('rec-label').value);
$('btn-record').onclick = () => {
  if (recorder.recording) {
    recorder.stop();
    $('btn-record').textContent = 'Start recording';
    $('rec-status').textContent = `Recorded ${recorder.rows.length.toLocaleString()} rows.`;
  } else {
    recorder.label = $('rec-label').value;
    recorder.start();
    $('btn-record').textContent = 'Stop recording';
  }
  $('btn-export').disabled = recorder.recording || !recorder.rows.length;
};
$('btn-export').onclick = () => {
  const blob = new Blob([recorder.toCSV()], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `wagvitals-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ---------- Settings ----------

function cloudSettings() {
  return { enabled: settings.cloudEnabled, endpoint: settings.endpoint, apiKey: settings.apiKey, deviceId: settings.deviceId };
}

$('btn-settings').onclick = () => {
  const form = $('settings-form').elements;
  form.name.value = profile.name ?? '';
  form.weightKg.value = profile.weightKg ?? '';
  form.idealWeightKg.value = profile.idealWeightKg ?? '';
  form.ageYears.value = profile.ageYears ?? '';
  form.fahrenheit.checked = settings.fahrenheit;
  form.showAllDevices.checked = settings.showAllDevices;
  form.cloudEnabled.checked = settings.cloudEnabled;
  form.endpoint.value = settings.endpoint;
  form.apiKey.value = settings.apiKey;
  $('settings').showModal();
};

$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  const form = $('settings-form').elements; // .elements: form.name would be the form's own name
  const num = (v) => (v === '' ? null : Number(v));
  const weightKg = num(form.weightKg.value) ?? profile.weightKg;
  profile = {
    ...profile,
    name: form.name.value.trim() || DEFAULT_PROFILE.name,
    weightKg,
    weightSource: weightKg !== profile.weightKg ? 'entered' : profile.weightSource,
    idealWeightKg: num(form.idealWeightKg.value),
    ageYears: num(form.ageYears.value),
  };
  settings = {
    ...settings,
    fahrenheit: form.fahrenheit.checked,
    showAllDevices: form.showAllDevices.checked,
    cloudEnabled: form.cloudEnabled.checked,
    endpoint: form.endpoint.value.trim(),
    apiKey: form.apiKey.value.trim(),
  };
  storage.set('profile', profile);
  storage.set('settings', settings);
  engine.resetBaseline();
  cloud.configure(cloudSettings());
  cloud.flush();
});
