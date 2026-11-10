// Bluetooth LE transport for the nRF52840 collar, built on the Web Bluetooth
// API. Works in the Electron desktop app and in Chrome/Edge on desktop.
// (Android WebViews lack Web Bluetooth; the future APK will swap in a
// Capacitor BLE transport with the same events and methods.)
//
// Transport interface (shared with SimulatedCollar):
//   connect(options) / disconnect() / send(command) / name / isConnected
//   events: 'sample' (parsed reading), 'line' (raw text), 'status' ({state, message})

import { BLE } from '../config.js';
import { Emitter } from '../util.js';
import {
  LineBuffer,
  parseLine,
  parseHeartRateMeasurement,
  parseTemperatureMeasurement,
  parseBatteryLevel,
} from './protocol.js';

export function bluetoothSupport() {
  if (!globalThis.navigator?.bluetooth) {
    return {
      ok: false,
      reason: 'Web Bluetooth is not available here. Use the WagVitals desktop app, or Chrome/Edge on desktop.',
    };
  }
  if (!globalThis.isSecureContext) {
    return { ok: false, reason: 'Bluetooth needs a secure page. Open the app via "npm run web" (localhost) or the desktop app.' };
  }
  return { ok: true };
}

// The device connected fine but is not a usable collar. Retrying cannot help.
export class IncompatibleCollarError extends Error {
  name = 'IncompatibleCollarError';
}

export class WebBluetoothCollar extends Emitter {
  device = null;
  rx = null;
  #lines = new LineBuffer();
  #decoder = new TextDecoder();
  #encoder = new TextEncoder();
  #userDisconnect = false;
  // True while connect() or the reconnect loop owns the link. Disconnect events
  // that arrive meanwhile belong to that attempt and must not start another
  // reconnect loop on top of it.
  #busy = false;

  get name() {
    return this.device?.name || 'WagVitals collar';
  }

  get isConnected() {
    return Boolean(this.device?.gatt?.connected);
  }

  async connect({ acceptAllDevices = false } = {}) {
    const support = bluetoothSupport();
    if (!support.ok) throw new Error(support.reason);
    if (navigator.bluetooth.getAvailability && !(await navigator.bluetooth.getAvailability())) {
      throw new Error('No Bluetooth adapter found, or Bluetooth is turned off.');
    }
    const optionalServices = [
      BLE.nusService,
      BLE.heartRateService,
      BLE.batteryService,
      BLE.thermometerService,
      BLE.deviceInfoService,
    ];
    const request = acceptAllDevices
      ? { acceptAllDevices: true, optionalServices }
      : {
          filters: [
            { namePrefix: BLE.deviceNamePrefix },
            { services: [BLE.nusService] },
            { services: [BLE.heartRateService] },
          ],
          optionalServices,
        };
    this.#userDisconnect = false;
    this.device = await navigator.bluetooth.requestDevice(request);
    this.device.addEventListener('gattserverdisconnected', this.#onDisconnected);
    this.#busy = true;
    try {
      await this.#connectGatt();
    } catch (err) {
      // The caller reports the error; this transport is finished.
      this.device.removeEventListener('gattserverdisconnected', this.#onDisconnected);
      if (this.device.gatt.connected) this.device.gatt.disconnect();
      throw err;
    } finally {
      this.#busy = false;
    }
  }

  async disconnect() {
    this.#userDisconnect = true;
    if (this.isConnected) {
      await this.send('STOP').catch(() => {});
      this.device.gatt.disconnect();
    } else {
      this.emit('status', { state: 'disconnected', message: 'Disconnected' });
    }
  }

  // Send a text command to the collar (see docs/BLE_PROTOCOL.md).
  async send(command) {
    if (!this.rx) return;
    const data = this.#encoder.encode(`${command}\n`);
    if (this.rx.properties.writeWithoutResponse) await this.rx.writeValueWithoutResponse(data);
    else await this.rx.writeValueWithResponse(data);
    this.emit('line', `> ${command}`);
  }

  async #connectGatt() {
    this.emit('status', { state: 'connecting', message: `Connecting to ${this.name}…` });
    const server = await this.device.gatt.connect();
    const services = [];

    // Main data stream: Nordic UART Service
    try {
      const nus = await server.getPrimaryService(BLE.nusService);
      const tx = await nus.getCharacteristic(BLE.nusTx);
      this.rx = await nus.getCharacteristic(BLE.nusRx).catch(() => null);
      tx.addEventListener('characteristicvaluechanged', this.#onUartData);
      await tx.startNotifications();
      services.push('UART');
    } catch {
      this.rx = null;
    }

    // Optional standard services
    if (await this.#subscribe(server, BLE.heartRateService, BLE.heartRateMeasurement, parseHeartRateMeasurement)) {
      services.push('Heart Rate');
    }
    if (await this.#subscribe(server, BLE.thermometerService, BLE.temperatureMeasurement, parseTemperatureMeasurement)) {
      services.push('Thermometer');
    }
    if (await this.#subscribe(server, BLE.batteryService, BLE.batteryLevel, parseBatteryLevel, true)) {
      services.push('Battery');
    }

    // Service lookups also fail when the link drops halfway, so check that
    // first: a dropped link is worth retrying, a wrong device is not.
    if (!this.device.gatt.connected) {
      throw Object.assign(new Error('The connection dropped while setting up.'), { name: 'NetworkError' });
    }
    if (!services.length) {
      throw new IncompatibleCollarError(
        `${this.name} has none of the WagVitals services (Nordic UART, Heart Rate, Thermometer, Battery). Check the collar firmware.`,
      );
    }
    this.emit('status', { state: 'connected', message: `Connected to ${this.name} (${services.join(', ')})` });
    await this.send('START').catch(() => {});
  }

  async #subscribe(server, serviceId, charId, parse, readFirst = false) {
    try {
      const service = await server.getPrimaryService(serviceId);
      const char = await service.getCharacteristic(charId);
      const handler = (event) => {
        const sample = parse(event.target.value);
        if (sample) this.emit('sample', sample);
      };
      if (readFirst && char.properties.read) handler({ target: { value: await char.readValue() } });
      if (char.properties.notify || char.properties.indicate) {
        char.oncharacteristicvaluechanged = handler; // property, so reconnects don't stack listeners
        await char.startNotifications();
      }
      return true;
    } catch {
      return false;
    }
  }

  #onUartData = (event) => {
    const text = this.#decoder.decode(event.target.value, { stream: true });
    for (const line of this.#lines.push(text)) {
      this.emit('line', line);
      const sample = parseLine(line);
      if (sample) this.emit('sample', sample);
    }
  };

  #onDisconnected = async () => {
    if (this.#busy) return;
    if (this.#userDisconnect) {
      this.emit('status', { state: 'disconnected', message: 'Disconnected' });
      return;
    }
    // Collar walked out of range or rebooted: try to reconnect with backoff.
    this.#busy = true;
    try {
      for (let attempt = 1; attempt <= BLE.reconnectAttempts; attempt++) {
        this.emit('status', {
          state: 'connecting',
          message: `Connection lost, reconnecting (${attempt}/${BLE.reconnectAttempts})…`,
        });
        await new Promise((r) => setTimeout(r, BLE.reconnectDelayMs * 2 ** (attempt - 1)));
        if (this.#userDisconnect) break;
        try {
          await this.#connectGatt();
          return;
        } catch (err) {
          if (this.device.gatt.connected) this.device.gatt.disconnect();
          if (err instanceof IncompatibleCollarError) {
            this.emit('status', { state: 'error', message: err.message });
            return;
          }
          // otherwise try again
        }
      }
      this.emit('status', { state: 'disconnected', message: 'Collar disconnected' });
    } finally {
      this.#busy = false;
    }
  };
}
