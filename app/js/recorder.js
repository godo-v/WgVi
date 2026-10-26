// Records raw sensor data and the app's activity decisions to CSV. Walk the
// dog with the collar on, set the label to what the dog is really doing, and
// the export becomes training/calibration data for the classifier (or a
// future machine-learning model).
//
// Columns: wall_ms, device_ms, channel, v1..v5, label
//   accel     v1-v3 = x, y, z (g)
//   gyro      v1-v3 = x, y, z (deg/s)
//   hr        v1 = bpm, v2 = quality (0-100)
//   temp      v1 = °C          resp  v1 = breaths/min
//   battery   v1 = %           weight v1 = kg
//   activity  v1 = detected state, v2 = confidence, v3 = VeDBA (g),
//             v4 = periodicity, v5 = cadence (Hz)

const MAX_ROWS = 500_000; // ~2.5 hours at 25 Hz plus vitals

export class Recorder {
  rows = [];
  labels = []; // [time, label] pairs: the label can change mid-recording
  recording = false;
  label = '';

  start(at = Date.now()) {
    this.rows = [];
    this.labels = [[at, this.label]];
    this.recording = true;
  }

  stop() {
    this.recording = false;
  }

  get full() {
    return this.rows.length >= MAX_ROWS;
  }

  addSample(s) {
    if (!this.recording || this.full) return;
    const v = {
      accel: [s.x, s.y, s.z],
      gyro: [s.x, s.y, s.z],
      hr: [s.bpm, s.quality],
      temp: [s.celsius],
      resp: [s.bpm],
      battery: [s.percent],
      weight: [s.kg],
    }[s.type];
    if (v) this.rows.push([s.at, s.t ?? '', s.type, ...v.map(num)]);
  }

  addActivity(update) {
    if (!this.recording || this.full || !update.activity) return;
    const { state, confidence } = update.activity;
    const f = update.features;
    this.rows.push([update.now, '', 'activity', state, num(confidence), num(f.vedba), num(f.periodicity), num(f.cadenceHz)]);
  }

  toCSV() {
    const header = 'wall_ms,device_ms,channel,v1,v2,v3,v4,v5,label';
    const lines = this.rows.map((r) => {
      const cells = [...r];
      while (cells.length < 8) cells.push('');
      cells.push(this.labelAt(r[0]));
      return cells.join(',');
    });
    return [header, ...lines].join('\n') + '\n';
  }

  setLabel(label, at = Date.now()) {
    this.label = label;
    if (this.recording) this.labels.push([at, label]);
  }

  labelAt(time) {
    let label = '';
    for (const [at, l] of this.labels) if (at <= time) label = l;
    return label;
  }
}

const num = (x) => (typeof x === 'number' ? Math.round(x * 10000) / 10000 : x);
