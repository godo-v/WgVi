import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLine,
  LineBuffer,
  parseHeartRateMeasurement,
  parseTemperatureMeasurement,
  parseBatteryLevel,
} from '../app/js/ble/protocol.js';

const view = (...bytes) => new DataView(new Uint8Array(bytes).buffer);

test('parses every collar message type', () => {
  assert.deepEqual(parseLine('A,1000,12,-980,35'), { type: 'accel', t: 1000, x: 0.012, y: -0.98, z: 0.035 });
  assert.deepEqual(parseLine('G,1000,1.5,-20,0'), { type: 'gyro', t: 1000, x: 1.5, y: -20, z: 0 });
  assert.deepEqual(parseLine('H,2000,88,97'), { type: 'hr', t: 2000, bpm: 88, quality: 97 });
  assert.deepEqual(parseLine('H,2000,88'), { type: 'hr', t: 2000, bpm: 88, quality: 100 });
  assert.deepEqual(parseLine('T,3000,38.62'), { type: 'temp', t: 3000, celsius: 38.62 });
  assert.deepEqual(parseLine('R,3000,22'), { type: 'resp', t: 3000, bpm: 22 });
  assert.deepEqual(parseLine('B,4000,81'), { type: 'battery', t: 4000, percent: 81 });
  assert.deepEqual(parseLine('W,5000,24.3'), { type: 'weight', t: 5000, kg: 24.3 });
  assert.deepEqual(parseLine('I,0,fw=0.1.0,hz=25'), { type: 'info', t: 0, text: 'fw=0.1.0,hz=25' });
  assert.equal(parseLine('a,1,0,0,1000\r').type, 'accel', 'lower case and CR tolerated');
});

test('rejects blank, comment, unknown and out-of-range lines', () => {
  for (const line of ['', '   ', '# boot ok', 'X,1,2', 'A,1,2,3', 'A,1,a,b,c', 'H,1,5', 'H,1,80,150', 'T,1,99', 'B,1,120', 'A,1,,0,0']) {
    assert.equal(parseLine(line), null, line);
  }
});

test('missing timestamp is allowed', () => {
  assert.equal(parseLine('H,,72').t, null);
});

test('LineBuffer reassembles lines split across BLE notifications', () => {
  const buf = new LineBuffer();
  assert.deepEqual(buf.push('A,1,0,0,10'), []);
  assert.deepEqual(buf.push('00\r\nH,2,7'), ['A,1,0,0,1000']);
  assert.deepEqual(buf.push('2\nT,3,38.5\nR,4'), ['H,2,72', 'T,3,38.5']);
  assert.deepEqual(buf.push(',20\n'), ['R,4,20']);
});

test('LineBuffer drops runaway garbage without newlines', () => {
  const buf = new LineBuffer();
  buf.push('x'.repeat(400));
  assert.deepEqual(buf.push('A,1,0,0,1000\n'), ['A,1,0,0,1000']);
});

test('standard Heart Rate Measurement: 8-bit, 16-bit and sensor contact', () => {
  assert.equal(parseHeartRateMeasurement(view(0x00, 72)).bpm, 72);
  assert.equal(parseHeartRateMeasurement(view(0x01, 0x2c, 0x01)).bpm, 300);
  assert.equal(parseHeartRateMeasurement(view(0x06, 90)).quality, 100, 'contact detected');
  assert.equal(parseHeartRateMeasurement(view(0x04, 90)).quality, 0, 'contact supported but lost');
});

test('standard Temperature Measurement (IEEE-11073 FLOAT)', () => {
  // 386 × 10^-1 = 38.6 °C
  assert.equal(parseTemperatureMeasurement(view(0x00, 0x82, 0x01, 0x00, 0xff)).celsius, 38.6);
  // 1015 × 10^-1 = 101.5 °F → 38.61 °C
  assert.equal(parseTemperatureMeasurement(view(0x01, 0xf7, 0x03, 0x00, 0xff)).celsius, 38.61);
  // NaN special value
  assert.equal(parseTemperatureMeasurement(view(0x00, 0xff, 0xff, 0x7f, 0x00)), null);
});

test('standard Battery Level', () => {
  assert.equal(parseBatteryLevel(view(57)).percent, 57);
});
