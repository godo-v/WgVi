import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../cloud/server.js';
import { CloudSync, MinuteSummarizer } from '../app/js/cloud/cloudSync.js';
import { Recorder } from '../app/js/recorder.js';
import { createStorage } from '../app/js/util.js';
import { runScenario } from './helpers.js';

async function startServer(apiKey = 'secret') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wagvitals-'));
  const server = createServer({ apiKey, dataFile: path.join(dir, 'summaries.jsonl') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, url, dir };
}

const summary = (i) => ({ periodStart: `2026-10-26T12:0${i}:00Z`, periodEnd: `2026-10-26T12:0${i + 1}:00Z`, activitySeconds: { walking: 60 } });

test('summarizer emits one compact summary per minute', () => {
  const { hub, engine } = runScenario('walking', 30);
  const summarizer = new MinuteSummarizer(60);
  const start = hub.lastSampleAt;
  const outputs = [];
  for (let s = 0; s <= 60; s++) {
    const out = summarizer.add({ ...engine.last, now: start + s * 1000, alerts: { raised: [] } }, hub);
    if (out) outputs.push(out);
  }
  assert.equal(outputs.length, 1, 'exactly one summary for one minute');
  const out = outputs[0];
  assert.deepEqual(out.activitySeconds, { walking: 60 });
  assert.ok(out.heartRate.avg > 85);
  assert.ok(JSON.stringify(out).length < 800, 'small enough to keep cloud costs low');
});

test('CloudSync uploads queued summaries to the reference server', async () => {
  const { server, url } = await startServer();
  try {
    const sync = new CloudSync({ storage: createStorage('test1.') });
    sync.configure({ enabled: true, endpoint: `${url}/`, apiKey: 'secret', deviceId: 'collar-1' });
    sync.enqueue(summary(1), 'Biscuit');
    sync.enqueue(summary(2), 'Biscuit');
    await sync.flush();
    assert.equal(sync.pending, 0);
    assert.equal(sync.status.error, null);

    const res = await fetch(`${url}/v1/summaries?deviceId=collar-1`, { headers: { Authorization: 'Bearer secret' } });
    const body = await res.json();
    assert.equal(body.summaries.length, 2);
    assert.equal(body.summaries[0].dogName, 'Biscuit');
    assert.equal(body.summaries[0].deviceId, 'collar-1');
  } finally {
    server.close();
  }
});

test('wrong API key is refused and summaries stay queued', async () => {
  const { server, url } = await startServer();
  try {
    const sync = new CloudSync({ storage: createStorage('test2.') });
    sync.configure({ enabled: true, endpoint: url, apiKey: 'wrong', deviceId: 'collar-1' });
    sync.enqueue(summary(1));
    await sync.flush();
    assert.equal(sync.pending, 1);
    assert.match(sync.status.error, /401/);
  } finally {
    server.close();
  }
});

test('offline: nothing is lost and disabled sync never calls out', async () => {
  let calls = 0;
  const sync = new CloudSync({ storage: createStorage('test3.'), fetchImpl: async () => { calls++; throw new Error('offline'); } });
  sync.enqueue(summary(1));
  await sync.flush();
  assert.equal(calls, 0, 'disabled by default');
  sync.configure({ enabled: true, endpoint: 'https://example.invalid', deviceId: 'x' });
  await sync.flush();
  assert.equal(calls, 1);
  assert.equal(sync.pending, 1);
  assert.equal(sync.status.error, 'offline');
});

test('server validates input and data survives a restart', async () => {
  const { server, url, dir } = await startServer('');
  try {
    const bad = await fetch(`${url}/v1/summaries`, { method: 'POST', body: '{"summaries": 3}' });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${url}/v1/summaries`, { method: 'POST', body: JSON.stringify({ deviceId: 'd', summaries: [summary(1), 'junk'] }) });
    assert.deepEqual(await ok.json(), { accepted: 1, rejected: 1 });
    const pre = await fetch(`${url}/v1/summaries`, { method: 'OPTIONS' });
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  } finally {
    server.close();
  }
  const again = createServer({ apiKey: '', dataFile: path.join(dir, 'summaries.jsonl') });
  await new Promise((r) => again.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${again.address().port}/healthz`);
    assert.equal((await res.json()).records, 1);
  } finally {
    again.close();
  }
});

test('recorder exports labelled CSV for calibration', () => {
  const rec = new Recorder();
  rec.label = 'walking';
  rec.start(1000);
  rec.addSample({ type: 'accel', at: 1001, t: 5, x: 0.01, y: -0.98, z: 0.1 });
  rec.setLabel('running', 2000);
  rec.addSample({ type: 'hr', at: 2001, t: 900, bpm: 150, quality: 80 });
  rec.addActivity({ now: 2002, activity: { state: 'running', confidence: 0.9 }, features: { vedba: 0.6, periodicity: 0.95, cadenceHz: 2.8 } });
  const lines = rec.toCSV().trim().split('\n');
  assert.equal(lines[0], 'wall_ms,device_ms,channel,v1,v2,v3,v4,v5,label');
  assert.equal(lines[1], '1001,5,accel,0.01,-0.98,0.1,,,walking');
  assert.equal(lines[2], '2001,900,hr,150,80,,,,running');
  assert.equal(lines[3], '2002,,activity,running,0.9,0.6,0.95,2.8,running');
});
