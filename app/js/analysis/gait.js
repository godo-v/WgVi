// Gait analysis (experimental). WagVitals' first product focuses on gait:
// spotting gradual changes in how a dog walks that can point to arthritis or
// other mobility problems.
//
// From a collar, the clearest gait signal is the head bob. A sound dog's bob
// repeats every step; a dog favouring a leg bobs differently on alternating
// steps (the classic "head nod" of forelimb lameness). Following the
// trunk-accelerometer method of Moe-Nilssen & Helbostad (2004):
//   step regularity    = autocorrelation at one step
//   stride regularity  = autocorrelation at one stride (two steps)
//   symmetry           = step / stride regularity (≈1 sound, lower = uneven)
// Only windows classified as walking are used.

const MIN_WINDOWS = 5;

export class GaitAnalyzer {
  constructor({ keep = 60 } = {}) {
    this.keep = keep;
    this.windows = [];
  }

  update(features, state) {
    if (state !== 'walking' || !features?.stepLag) return;
    const { ac, stepLag } = features;
    const strideLag = peakNear(ac, 2 * stepLag, Math.max(1, Math.round(stepLag * 0.25)));
    if (!strideLag) return;
    const stepReg = Math.max(0, ac[stepLag]);
    const strideReg = Math.max(0, ac[strideLag]);
    if (strideReg < 0.2) return;
    this.windows.push({
      stepRegularity: stepReg,
      strideRegularity: strideReg,
      symmetry: Math.min(1, stepReg / strideReg),
      cadenceHz: features.cadenceHz,
    });
    if (this.windows.length > this.keep) this.windows.shift();
  }

  summary() {
    const n = this.windows.length;
    if (n < MIN_WINDOWS) return null;
    const avg = (key) => this.windows.reduce((sum, w) => sum + w[key], 0) / n;
    return {
      windows: n,
      regularity: avg('strideRegularity'),
      symmetry: avg('symmetry'),
      cadenceHz: avg('cadenceHz'),
    };
  }

  reset() {
    this.windows = [];
  }
}

function peakNear(ac, center, radius) {
  let best = 0;
  for (let k = center - radius; k <= center + radius; k++) {
    if (k > 0 && k < ac.length && (!best || ac[k] > ac[best])) best = k;
  }
  return best;
}
