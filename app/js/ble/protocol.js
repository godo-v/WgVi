// WagVitals collar data protocol (full spec: docs/BLE_PROTOCOL.md).
//
// The nRF52840 sends ASCII lines over the Nordic UART Service:
//   <TYPE>,<device_ms>,<value>[,<value>...]\n
// Text keeps the firmware simple and lets the team read the stream in the
// nRF Connect phone app while debugging.

const MAX_LINE = 256;

const PARSERS = {
  // Accelerometer, milli-g → g
  A: (t, v) => vec('accel', t, v, 1 / 1000, 16),
  // Gyroscope, degrees per second
  G: (t, v) => vec('gyro', t, v, 1, 4000),
  // Heart rate, beats/min, optional signal quality 0-100
  H: (t, [bpm, quality = 100]) =>
    inRange(bpm, 20, 400) && inRange(quality, 0, 100) ? { type: 'hr', t, bpm, quality } : null,
  // Temperature, °C
  T: (t, [celsius]) => (inRange(celsius, 20, 46) ? { type: 'temp', t, celsius } : null),
  // Breathing (respiration) rate, breaths/min
  R: (t, [bpm]) => (inRange(bpm, 1, 400) ? { type: 'resp', t, bpm } : null),
  // Battery, percent
  B: (t, [percent]) => (inRange(percent, 0, 100) ? { type: 'battery', t, percent } : null),
  // Body weight in kg (manual entry today, WagVitals smart bed later)
  W: (t, [kg]) => (inRange(kg, 0.2, 150) ? { type: 'weight', t, kg } : null),
};

function inRange(x, lo, hi) {
  return Number.isFinite(x) && x >= lo && x <= hi;
}

function vec(type, t, values, scale, limit) {
  if (values.length < 3) return null;
  const [x, y, z] = values.map((n) => n * scale);
  if (![x, y, z].every((n) => inRange(n, -limit, limit))) return null;
  return { type, t, x, y, z };
}

// Parse one protocol line. Returns a sample object, or null if the line is
// blank, a comment (#...), or malformed.
export function parseLine(line) {
  const text = line.trim();
  if (!text || text.startsWith('#')) return null;
  const parts = text.split(',');
  const kind = parts[0].trim().toUpperCase();
  const t = parts[1]?.trim() ? Number(parts[1]) : NaN; // Number('') would be 0
  const time = Number.isFinite(t) ? t : null;
  if (kind === 'I') return { type: 'info', t: time, text: parts.slice(2).join(',').trim() };
  const parser = PARSERS[kind];
  if (!parser || parts.length < 3) return null;
  const values = parts.slice(2).map((p) => (p.trim() === '' ? NaN : Number(p)));
  return parser(time, values);
}

// ---- Plain numbers, as the Bluefruit Connect Plotter accepts them ----
//
// Many sketches print readings straight from the IMU library:
//   bleuart.print(x); bleuart.print(" "); bleuart.print(y); ... println(z);
// i.e. a line of numbers separated by commas, semicolons, spaces or tabs, with
// no type letter, no timestamp and no units. The Bluefruit Plotter graphs such
// lines; the WagVitals protocol above would drop them. The first three numbers
// are taken as accelerometer x, y, z (a 6-value line is usually accel + gyro).

const PLAIN_SPLIT = /[,;\s]+/;
const GRAVITY = 9.80665;

// Numbers of a plain line, or null if it is not a line of 3+ numbers.
export function parsePlainNumbers(line) {
  const parts = line.trim().split(PLAIN_SPLIT).filter(Boolean);
  if (parts.length < 3) return null;
  const values = parts.map(Number);
  return values.every(Number.isFinite) ? values : null;
}

// Plain numbers carry no units. The Adafruit sensor libraries report m/s²
// (what the team's sketch prints), but sketches also send g or milli-g. The
// size of gravity tells them apart: a collar measures about 1 g overall, so
// the median magnitude of the first samples is ~9.8 (m/s²), ~1 (g) or ~1000
// (milli-g). Until enough samples are in, m/s² is assumed.
export class PlainAccelDecoder {
  #magnitudes = [];
  unit = null; // 'm/s2' | 'g' | 'mg' once decided

  static SAMPLES_TO_DECIDE = 10;
  static SCALE = { 'm/s2': 1 / GRAVITY, g: 1, mg: 1 / 1000 };

  // Returns { sample, decided } where decided is the unit if it was settled now.
  decode(values) {
    const [x, y, z] = values;
    let decided = null;
    if (!this.unit) {
      this.#magnitudes.push(Math.hypot(x, y, z));
      if (this.#magnitudes.length >= PlainAccelDecoder.SAMPLES_TO_DECIDE) {
        const sorted = [...this.#magnitudes].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        this.unit = median > 200 ? 'mg' : median > 3 ? 'm/s2' : 'g';
        decided = this.unit;
      }
    }
    const scale = PlainAccelDecoder.SCALE[this.unit ?? 'm/s2'];
    const g = [x, y, z].map((v) => Math.round(v * scale * 1000) / 1000);
    if (!g.every((v) => Math.abs(v) <= 16)) return { sample: null, decided };
    return { sample: { type: 'accel', t: null, x: g[0], y: g[1], z: g[2] }, decided };
  }
}

// BLE notifications are limited by the MTU (often 20-244 bytes), so a line can
// be split across notifications or several lines can share one. LineBuffer
// reassembles complete lines.
export class LineBuffer {
  #pending = '';

  push(chunk) {
    this.#pending += chunk;
    const lines = this.#pending.split(/\r?\n/);
    this.#pending = lines.pop();
    if (this.#pending.length > MAX_LINE) this.#pending = ''; // garbage without newlines
    return lines.filter((l) => l.trim() !== '');
  }
}

// ---- Standard Bluetooth SIG characteristics (optional on the collar) ----

// Heart Rate Measurement (0x2A37)
export function parseHeartRateMeasurement(view) {
  const flags = view.getUint8(0);
  const bpm = flags & 0x01 ? view.getUint16(1, true) : view.getUint8(1);
  const contactSupported = (flags & 0x04) !== 0;
  const contact = (flags & 0x02) !== 0;
  return { type: 'hr', t: null, bpm, quality: contactSupported && !contact ? 0 : 100 };
}

// Temperature Measurement (0x2A1C): flags byte + IEEE-11073 32-bit FLOAT
export function parseTemperatureMeasurement(view) {
  const flags = view.getUint8(0);
  let mantissa = view.getUint32(1, true) & 0x00ffffff;
  const exponent = view.getInt8(4);
  if (mantissa >= 0x7ffffe && mantissa <= 0x800002) return null; // NaN / NRes / ±INF
  if (mantissa & 0x00800000) mantissa -= 0x01000000;
  let value = mantissa * 10 ** exponent;
  if (flags & 0x01) value = ((value - 32) * 5) / 9; // Fahrenheit → Celsius
  return { type: 'temp', t: null, celsius: Math.round(value * 100) / 100 };
}

// Battery Level (0x2A19)
export function parseBatteryLevel(view) {
  return { type: 'battery', t: null, percent: view.getUint8(0) };
}
