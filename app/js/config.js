// Central configuration: Bluetooth UUIDs, analysis settings, vital-sign ranges
// and activity-classifier thresholds.
//
// The thresholds are STARTING POINTS chosen from published collar-accelerometer
// work and tuned against the built-in simulator. They must be calibrated with
// recordings from the real collar (Record data → Export CSV) before the
// classifications can be trusted. See docs/ACTIVITY_DETECTION.md.

export const BLE = {
  // The collar should advertise a name starting with this prefix.
  deviceNamePrefix: 'WagVitals',
  // Nordic UART Service (NUS): the standard nRF52840 "serial over BLE" service.
  // All WagVitals sensor data travels over it as text lines (docs/BLE_PROTOCOL.md).
  nusService: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  nusRx: '6e400002-b5a3-f393-e0a9-e50e24dcca9e', // app → collar (write)
  nusTx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e', // collar → app (notify)
  // Optional standard Bluetooth SIG services the firmware may also expose.
  heartRateService: 'heart_rate',
  heartRateMeasurement: 'heart_rate_measurement',
  batteryService: 'battery_service',
  batteryLevel: 'battery_level',
  thermometerService: 'health_thermometer',
  temperatureMeasurement: 'temperature_measurement',
  deviceInfoService: 'device_information',
  reconnectAttempts: 3,
  reconnectDelayMs: 1000, // doubles after each failed attempt
};

export const ANALYSIS = {
  windowSec: 4, // sliding window used for activity features
  hopSec: 1, // classify once per second
  defaultSampleHz: 25, // used when the collar's timestamps are unusable
  hrMaxAgeSec: 5, // heart-rate readings older than this are ignored
  hrMinQuality: 30, // 0-100; lower-quality readings (motion artefacts) are ignored
  hrWeight: 0.5, // 0 = accelerometer only, 1 = heart rate can fully veto a class
  smoothing: 0.5, // EMA factor applied to class scores (higher = switches faster)
  sleepAfterSec: 120, // still rest with a calm heart for this long = sleeping
  sleepStillVedba: 0.012, // g; movement must stay below this to count towards sleep
  learnRestingHrRate: 0.01, // how fast the resting-HR baseline adapts during rest
  restingHrSettleSec: 60, // rest this long before heart rate counts as "resting"
  signalLostSec: 10,
  staleVitalSec: 30, // temperature/breathing readings older than this are hidden
};

// Each array is a fuzzy membership edge: [a, b] ramps 0→1 between a and b,
// [a, b, c, d] is a trapezoid (0 below a, 1 between b and c, 0 above d).
export const ACTIVITY_THRESHOLDS = {
  // VeDBA: mean dynamic body acceleration over the window, in g.
  rest: [0.02, 0.05],
  light: [0.02, 0.05, 0.1, 0.18],
  walk: [0.06, 0.12, 0.4, 0.6],
  run: [0.4, 0.65],
  play: [0.15, 0.35],
  // Periodicity: autocorrelation peak of the movement signal (0..1).
  rhythmic: [0.3, 0.6],
  irregular: [0.35, 0.6],
  // Burstiness: coefficient of variation of movement across 0.5 s slices.
  // Walking and running are steady; play is stop-and-go.
  unsteady: [0.3, 0.6],
  // Dominant movement frequency at the collar, in Hz.
  walkCadenceHz: [0.7, 1.0, 2.6, 3.2],
  runCadenceHz: [1.8, 2.6],
  // Heart rate expressed as a multiple of the dog's resting heart rate.
  hrRest: [1.15, 1.35],
  hrLight: [0.9, 1.0, 1.3, 1.5],
  hrWalk: [1.0, 1.15, 1.6, 1.9],
  hrRun: [1.4, 1.8],
  hrPlay: [1.25, 1.6],
};

export const ACTIVITIES = {
  sleeping: { label: 'Sleeping', icon: '💤', active: false },
  resting: { label: 'Resting', icon: '🛏️', active: false },
  light: { label: 'Light activity', icon: '🐾', active: false },
  walking: { label: 'Walking', icon: '🐕', active: true },
  running: { label: 'Running', icon: '💨', active: true },
  playing: { label: 'Playing', icon: '🎾', active: true },
};

// Typical canine values; WagVitals' veterinary advisors should confirm them.
export const VITALS = {
  tempC: { normalLow: 38.3, normalHigh: 39.2, low: 37.5, high: 39.5, critical: 40.5 },
  // A collar sensor reads skin/fur temperature, not core temperature. Set this
  // after comparing collar readings with a rectal thermometer.
  tempOffsetC: 0,
  respRestingMax: 30, // breaths/min while resting or asleep
  batteryLow: 15,
  gaitSymmetryMin: 0.85,
};

export const SIZE_PROFILES = {
  small: { label: 'Small (under 10 kg)', restingHr: 100, restingHrMax: 140, maxHr: 220, goalMin: 45 },
  medium: { label: 'Medium (10–25 kg)', restingHr: 85, restingHrMax: 120, maxHr: 200, goalMin: 60 },
  large: { label: 'Large (over 25 kg)', restingHr: 70, restingHrMax: 100, maxHr: 190, goalMin: 75 },
};

export const CLOUD = {
  summaryPeriodSec: 60, // only one summary per minute leaves the device
  maxQueued: 1440, // one day of summaries
  batchSize: 100,
};
