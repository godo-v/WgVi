// WagVitals cloud ingest API (reference implementation, zero dependencies).
//
//   POST /v1/summaries   {deviceId, summaries: [...]}   store per-minute summaries
//   GET  /v1/summaries?deviceId=…&limit=…                read them back
//   GET  /healthz                                        health check
//
// Auth: "Authorization: Bearer <API_KEY>" when the API_KEY env var is set.
// Storage: newline-delimited JSON in DATA_FILE. Container platforms such as
// Cloud Run have temporary disks, so for long-term storage swap appendRecords()
// for Firestore / Cosmos DB / DynamoDB (see cloud/README.md).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_BODY = 1_000_000;
const MAX_IN_MEMORY = 50_000;

export function createServer({
  apiKey = process.env.API_KEY || '',
  dataFile = process.env.DATA_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'summaries.jsonl'),
} = {}) {
  const records = loadRecords(dataFile);

  function appendRecords(newRecords) {
    records.push(...newRecords);
    if (records.length > MAX_IN_MEMORY) records.splice(0, records.length - MAX_IN_MEMORY);
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.appendFileSync(dataFile, newRecords.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'server error' });
    });
  });

  async function handle(req, res) {
    // The desktop app runs from file:// and the web build from localhost, so allow any origin.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'OPTIONS') return send(res, 204);
    if (url.pathname === '/healthz') return send(res, 200, { ok: true, records: records.length });
    if (url.pathname !== '/v1/summaries') return send(res, 404, { error: 'not found' });
    if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) return send(res, 401, { error: 'bad API key' });

    if (req.method === 'GET') {
      const deviceId = url.searchParams.get('deviceId');
      const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 1000);
      const rows = records.filter((r) => !deviceId || r.deviceId === deviceId).slice(-limit);
      return send(res, 200, { summaries: rows });
    }

    if (req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        return send(res, err.message === 'too large' ? 413 : 400, { error: err.message === 'too large' ? 'body too large' : 'invalid JSON' });
      }
      const { deviceId, summaries } = body ?? {};
      if (typeof deviceId !== 'string' || !deviceId || !Array.isArray(summaries)) {
        return send(res, 400, { error: 'expected {deviceId: string, summaries: array}' });
      }
      const receivedAt = new Date().toISOString();
      const valid = summaries.filter((s) => s && typeof s === 'object' && typeof s.periodEnd === 'string');
      appendRecords(valid.map((s) => ({ ...s, deviceId, receivedAt })));
      return send(res, 200, { accepted: valid.length, rejected: summaries.length - valid.length });
    }
    return send(res, 405, { error: 'method not allowed' });
  }
}

function loadRecords(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-MAX_IN_MEMORY)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body) {
  if (body === undefined) return res.writeHead(status).end();
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 8080;
  createServer().listen(port, () => {
    console.log(`WagVitals cloud API listening on port ${port}${process.env.API_KEY ? '' : ' (no API_KEY set: open to anyone)'}`);
  });
}
