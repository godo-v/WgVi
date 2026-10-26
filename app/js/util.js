// Small helpers shared by the app, the simulator and the tests.

export class Emitter {
  #handlers = new Map();

  on(event, fn) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(fn);
    return () => this.#handlers.get(event)?.delete(fn);
  }

  emit(event, data) {
    for (const fn of this.#handlers.get(event) ?? []) {
      try {
        fn(data);
      } catch (err) {
        console.error(`Error in "${event}" handler`, err);
      }
    }
  }
}

// localStorage wrapper that never throws and falls back to memory
// (private windows, Node tests, blocked storage).
export function createStorage(prefix = 'wagvitals.') {
  let ls = null;
  try {
    ls = globalThis.localStorage ?? null;
    ls?.getItem('probe');
  } catch {
    ls = null;
  }
  const memory = new Map();
  return {
    get(key, fallback) {
      try {
        const raw = memory.has(key) ? memory.get(key) : ls?.getItem(prefix + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      const raw = JSON.stringify(value);
      try {
        if (!ls) throw new Error('no localStorage');
        ls.setItem(prefix + key, raw);
        memory.delete(key);
      } catch {
        memory.set(key, raw);
      }
    },
  };
}

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function todayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Deterministic pseudo-random numbers so simulator runs are reproducible in tests.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand) {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
