// Accelerometer feature extraction for one analysis window.
//
//   vedba        mean dynamic body acceleration (g): how much the dog moves
//   periodicity  0..1 autocorrelation peak: how rhythmic the movement is
//   cadenceHz    dominant rhythm frequency (step frequency when walking)
//   burstiness   variation of movement between 0.5 s slices: stop-and-go play
//   peak         largest single dynamic acceleration (g)
//
// Everything is computed from the acceleration magnitude or with gravity
// removed per axis, so it doesn't matter how the collar sits on the neck.

const MAX_CADENCE_HZ = 5;
const MIN_CADENCE_HZ = 0.5;

export function accelFeatures(samples, { defaultHz = 25 } = {}) {
  const n = samples.length;
  if (n < 16) return null;
  const spanSec = (samples[n - 1].t - samples[0].t) / 1000;
  const fs = spanSec > 0 ? (n - 1) / spanSec : defaultHz;

  // Gravity = per-axis mean; what's left is the dog's own movement.
  let mx = 0, my = 0, mz = 0;
  for (const s of samples) {
    mx += s.x;
    my += s.y;
    mz += s.z;
  }
  mx /= n;
  my /= n;
  mz /= n;

  const dyn = new Float64Array(n);
  const mag = new Float64Array(n);
  let vedba = 0, meanMag = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    const { x, y, z } = samples[i];
    dyn[i] = Math.hypot(x - mx, y - my, z - mz);
    mag[i] = Math.hypot(x, y, z);
    vedba += dyn[i];
    meanMag += mag[i];
    if (dyn[i] > peak) peak = dyn[i];
  }
  vedba /= n;
  meanMag /= n;
  for (let i = 0; i < n; i++) mag[i] -= meanMag;

  const maxLag = Math.min(Math.round(fs / MIN_CADENCE_HZ), Math.floor(n / 2));
  const ac = autocorrelation(mag, maxLag);
  const { periodicity, lag } = dominantPeriod(ac, Math.max(2, Math.round(fs / MAX_CADENCE_HZ)), maxLag);

  return {
    n,
    fs,
    spanSec,
    vedba,
    periodicity,
    cadenceHz: lag ? fs / lag : 0,
    stepLag: lag,
    burstiness: burstiness(dyn, Math.max(2, Math.round(fs / 2))),
    peak,
    gravity: [mx, my, mz],
    ac,
  };
}

// Normalised, unbiased autocorrelation of a zero-mean signal for lags 0..maxLag.
export function autocorrelation(x, maxLag) {
  const n = x.length;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += x[i] * x[i];
  energy /= n;
  const out = new Float64Array(maxLag + 1);
  if (energy < 1e-12) return out;
  for (let k = 0; k <= maxLag; k++) {
    let sum = 0;
    for (let i = 0; i + k < n; i++) sum += x[i] * x[i + k];
    out[k] = sum / (n - k) / energy;
  }
  return out;
}

// Find the movement rhythm: after the autocorrelation first dips below zero,
// the highest peak gives the strength of the rhythm. The first peak that is at
// least half as high is the step period (later peaks are whole strides).
export function dominantPeriod(ac, minLag, maxLag) {
  let zero = 1;
  while (zero <= maxLag && ac[zero] >= 0) zero++;
  if (zero > maxLag) return { periodicity: 0, lag: 0 };

  const peaks = [];
  for (let k = Math.max(zero, minLag); k < maxLag; k++) {
    if (ac[k] > 0 && ac[k] >= ac[k - 1] && ac[k] >= ac[k + 1]) peaks.push(k);
  }
  if (!peaks.length) return { periodicity: 0, lag: 0 };
  const best = Math.max(...peaks.map((k) => ac[k]));
  const lag = peaks.find((k) => ac[k] >= 0.5 * best);
  return { periodicity: Math.min(1, best), lag };
}

function burstiness(dyn, slice) {
  const means = [];
  for (let i = 0; i + slice <= dyn.length; i += slice) {
    let sum = 0;
    for (let j = i; j < i + slice; j++) sum += dyn[j];
    means.push(sum / slice);
  }
  if (means.length < 2) return 0;
  const mean = means.reduce((a, b) => a + b, 0) / means.length;
  if (mean < 1e-6) return 0;
  const variance = means.reduce((a, b) => a + (b - mean) ** 2, 0) / means.length;
  return Math.sqrt(variance) / mean;
}
