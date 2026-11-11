// Exercises the Web Bluetooth transport against a fake nRF52840 GATT server.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { BLE } from '../app/js/config.js';
import { WebBluetoothCollar } from '../app/js/ble/webBluetooth.js';

class FakeCharacteristic extends EventTarget {
  constructor(properties, readBytes = null) {
    super();
    this.properties = properties;
    this.readBytes = readBytes;
    this.written = [];
  }
  async startNotifications() {
    this.notifying = true;
  }
  async readValue() {
    return new DataView(new Uint8Array(this.readBytes).buffer);
  }
  async writeValueWithoutResponse(data) {
    this.written.push(new TextDecoder().decode(data));
  }
  notify(bytes) {
    this.value = new DataView(bytes.buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
    this.oncharacteristicvaluechanged?.({ target: this });
  }
}

function fakeCollar() {
  const tx = new FakeCharacteristic({ notify: true });
  const rx = new FakeCharacteristic({ writeWithoutResponse: true });
  const hrm = new FakeCharacteristic({ notify: true });
  const battery = new FakeCharacteristic({ read: true, notify: true }, [77]);
  const services = {
    [BLE.nusService]: { [BLE.nusTx]: tx, [BLE.nusRx]: rx },
    [BLE.heartRateService]: { [BLE.heartRateMeasurement]: hrm },
    [BLE.batteryService]: { [BLE.batteryLevel]: battery },
  };
  const notFound = () => Promise.reject(Object.assign(new Error('not found'), { name: 'NotFoundError' }));
  const device = new EventTarget();
  device.name = 'WagVitals-01';
  device.gatt = {
    connected: false,
    async connect() {
      this.connected = true;
      return {
        getPrimaryService: async (id) => {
          const chars = services[id];
          if (!chars) return notFound();
          return { getCharacteristic: async (cid) => chars[cid] ?? notFound() };
        },
        disconnect: () => device.gatt.disconnect(),
      };
    },
    disconnect() {
      this.connected = false;
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
  };
  return { device, tx, rx, hrm };
}

let fake;
let lastRequest;
beforeEach(() => {
  fake = fakeCollar();
  globalThis.isSecureContext = true;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      bluetooth: {
        getAvailability: async () => true,
        requestDevice: async (options) => {
          lastRequest = options;
          return fake.device;
        },
      },
    },
  });
});

test('connects, subscribes to UART + Battery and sends START', async () => {
  const collar = new WebBluetoothCollar();
  const statuses = [];
  const samples = [];
  collar.on('status', (s) => statuses.push(s));
  collar.on('sample', (s) => samples.push(s));
  await collar.connect();

  assert.deepEqual(lastRequest.filters[0], { namePrefix: 'WagVitals' });
  assert.deepEqual(lastRequest.filters[1], { namePrefix: 'Wagvitals' }, 'name the current firmware uses');
  assert.ok(lastRequest.optionalServices.includes(BLE.nusService));
  assert.equal(statuses.at(-1).state, 'connected');
  assert.match(statuses.at(-1).message, /\(UART, Battery\)/);
  assert.deepEqual(fake.rx.written, ['START\n']);
  assert.deepEqual(samples, [{ type: 'battery', t: null, percent: 77 }]);
  assert.equal(collar.isConnected, true);
});

test('UART text split across notifications becomes samples', async () => {
  const collar = new WebBluetoothCollar();
  const samples = [];
  const lines = [];
  collar.on('sample', (s) => samples.push(s));
  collar.on('line', (l) => lines.push(l));
  await collar.connect();
  samples.length = 0;
  const enc = new TextEncoder();
  fake.tx.notify(enc.encode('A,100,10,-990,20\nH,10'));
  fake.tx.notify(enc.encode('0,72,95\nbad line\n'));
  // Heart rate from the collar is ignored: vitals are simulated in the app.
  assert.deepEqual(samples, [{ type: 'accel', t: 100, x: 0.01, y: -0.99, z: 0.02 }]);
  assert.ok(lines.includes('bad line'), 'raw lines are logged for debugging');
});

test('heart rate from the collar is ignored (vitals are simulated)', async () => {
  const collar = new WebBluetoothCollar();
  const samples = [];
  collar.on('sample', (s) => samples.push(s));
  await collar.connect();
  samples.length = 0;
  fake.hrm.notify(new Uint8Array([0x00, 81]));
  fake.tx.notify(new TextEncoder().encode('H,1,81,95\nT,1,38.5\nR,1,20\n'));
  assert.deepEqual(samples, []);
});

// The current firmware: named "Wagvitals", advertises Heart Rate 0x180D with
// no characteristics, and has no Nordic UART service.
test('collar with only an empty Heart Rate service connects and says it sends no data', async () => {
  fake.device.name = 'Wagvitals';
  const realConnect = fake.device.gatt.connect;
  fake.device.gatt.connect = async function () {
    const server = await realConnect.call(this);
    return {
      ...server,
      getPrimaryService: async (id) => {
        if (id !== BLE.heartRateService) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
        return { getCharacteristic: async () => Promise.reject(new Error('none')) };
      },
    };
  };
  const collar = new WebBluetoothCollar();
  const statuses = [];
  collar.on('status', (s) => statuses.push(s));
  await collar.connect();
  assert.equal(collar.isConnected, true, 'stays connected: no connect/disconnect cycle');
  assert.equal(collar.dataless, true);
  assert.equal(statuses.at(-1).state, 'connected');
  assert.match(statuses.at(-1).message, /sends no accelerometer data over Bluetooth/);
});

test('user disconnect sends STOP and reports disconnected', async () => {
  const collar = new WebBluetoothCollar();
  const statuses = [];
  collar.on('status', (s) => statuses.push(s.state));
  await collar.connect();
  await collar.disconnect();
  assert.equal(fake.rx.written.at(-1), 'STOP\n');
  assert.equal(statuses.at(-1), 'disconnected');
  assert.equal(collar.isConnected, false);
});

test('a device without WagVitals services is rejected with a clear message', async () => {
  fake.device.gatt.connect = async function () {
    this.connected = true;
    return { getPrimaryService: async () => Promise.reject(new Error('nope')), disconnect: () => {} };
  };
  await assert.rejects(new WebBluetoothCollar().connect(), /none of the WagVitals services/);
});

// Regression: a collar advertising Heart Rate (0x180D) with no characteristics
// used to make the app connect and disconnect forever, because rejecting the
// device fired 'gattserverdisconnected', which started a reconnect loop, whose
// own rejections fired the event again.
test('rejecting an incompatible collar does not start a reconnect loop', async () => {
  BLE.reconnectDelayMs = 1;
  let connects = 0;
  const realConnect = fake.device.gatt.connect;
  fake.device.gatt.connect = async function () {
    connects++;
    const server = await realConnect.call(this);
    return { ...server, getPrimaryService: async () => Promise.reject(new Error('none')) };
  };
  const collar = new WebBluetoothCollar();
  const statuses = [];
  collar.on('status', (s) => statuses.push(s.state));
  await assert.rejects(collar.connect(), /none of the WagVitals services/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(connects, 1);
  assert.equal(collar.isConnected, false);
  assert.deepEqual(statuses, ['connecting']);
});

test('a lost connection is retried a limited number of times, without overlapping', async () => {
  BLE.reconnectDelayMs = 1;
  const collar = new WebBluetoothCollar();
  await collar.connect();
  const statuses = [];
  collar.on('status', (s) => statuses.push(s));
  let connects = 0;
  fake.device.gatt.connect = async function () {
    connects++;
    // the link comes up and drops again straight away
    this.connected = true;
    this.disconnect();
    throw Object.assign(new Error('gone'), { name: 'NetworkError' });
  };
  fake.device.gatt.disconnect();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(connects, BLE.reconnectAttempts);
  assert.equal(statuses.at(-1).message, 'Collar disconnected');
});

test('a collar that comes back is reconnected', async () => {
  BLE.reconnectDelayMs = 1;
  const collar = new WebBluetoothCollar();
  await collar.connect();
  const statuses = [];
  collar.on('status', (s) => statuses.push(s.state));
  fake.device.gatt.disconnect();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(statuses.at(-1), 'connected');
  assert.equal(collar.isConnected, true);
});

// firmware/wagvitals_imu: "Wagvitals", empty 0x180D + Nordic UART, sending
// A,<millis>,<milli-g x>,<y>,<z> converted from the IMU's m/s^2.
test('the team IMU sketch streams accelerometer lines the app turns into g', async () => {
  fake.device.name = 'Wagvitals';
  const collar = new WebBluetoothCollar();
  const samples = [];
  collar.on('sample', (s) => samples.push(s));
  await collar.connect();
  samples.length = 0;
  const toMilliG = (ms2) => Math.trunc((ms2 * 1000) / 9.80665); // same as the C (int) cast
  const line = (t, x, y, z) => `A,${t},${toMilliG(x)},${toMilliG(y)},${toMilliG(z)}\n`;
  // 20-byte notifications, as with the default BLE packet size
  const text = line(5040, 0.12, -9.81, 0.35) + line(5080, 1.5, -9.6, -0.2);
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += 20) fake.tx.notify(bytes.slice(i, i + 20));
  assert.deepEqual(samples, [
    { type: 'accel', t: 5040, x: 0.012, y: -1.0, z: 0.035 },
    { type: 'accel', t: 5080, x: 0.152, y: -0.978, z: -0.02 },
  ]);
  assert.equal(collar.dataless, false);
});

test('acceptAllDevices option lists every device (debugging)', async () => {
  await new WebBluetoothCollar().connect({ acceptAllDevices: true });
  assert.equal(lastRequest.acceptAllDevices, true);
  assert.equal(lastRequest.filters, undefined);
});

test('missing Web Bluetooth gives a helpful error', async () => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  await assert.rejects(new WebBluetoothCollar().connect(), /Web Bluetooth is not available/);
});
