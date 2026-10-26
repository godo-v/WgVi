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

test('connects, subscribes to UART + Heart Rate + Battery and sends START', async () => {
  const collar = new WebBluetoothCollar();
  const statuses = [];
  const samples = [];
  collar.on('status', (s) => statuses.push(s));
  collar.on('sample', (s) => samples.push(s));
  await collar.connect();

  assert.deepEqual(lastRequest.filters[0], { namePrefix: 'WagVitals' });
  assert.ok(lastRequest.optionalServices.includes(BLE.nusService));
  assert.equal(statuses.at(-1).state, 'connected');
  assert.match(statuses.at(-1).message, /UART, Heart Rate, Battery/);
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
  assert.deepEqual(samples, [
    { type: 'accel', t: 100, x: 0.01, y: -0.99, z: 0.02 },
    { type: 'hr', t: 100, bpm: 72, quality: 95 },
  ]);
  assert.ok(lines.includes('bad line'), 'raw lines are logged for debugging');
});

test('standard Heart Rate Service notifications become samples', async () => {
  const collar = new WebBluetoothCollar();
  const samples = [];
  collar.on('sample', (s) => samples.push(s));
  await collar.connect();
  fake.hrm.notify(new Uint8Array([0x00, 81]));
  assert.equal(samples.at(-1).bpm, 81);
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

test('acceptAllDevices option lists every device (debugging)', async () => {
  await new WebBluetoothCollar().connect({ acceptAllDevices: true });
  assert.equal(lastRequest.acceptAllDevices, true);
  assert.equal(lastRequest.filters, undefined);
});

test('missing Web Bluetooth gives a helpful error', async () => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  await assert.rejects(new WebBluetoothCollar().connect(), /Web Bluetooth is not available/);
});
