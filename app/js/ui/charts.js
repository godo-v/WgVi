// Minimal canvas line chart (no external libraries, works offline).

export function drawLines(canvas, series, { min, max } = {}) {
  const dpr = globalThis.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const values = series.flatMap((s) => s.points.map((p) => p[1]));
  if (!values.length) return;
  let lo = min ?? Math.min(...values);
  let hi = max ?? Math.max(...values);
  if (hi - lo < 1e-6) {
    lo -= 1;
    hi += 1;
  }
  const xs = series.flatMap((s) => s.points.map((p) => p[0]));
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const pad = 4;
  const sx = (x) => (x1 === x0 ? w : ((x - x0) / (x1 - x0)) * w);
  const sy = (y) => h - pad - ((y - lo) / (hi - lo)) * (h - 2 * pad);

  const style = getComputedStyle(canvas);
  ctx.strokeStyle = style.getPropertyValue('--border').trim() || '#ccc';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, sy((lo + hi) / 2));
  ctx.lineTo(w, sy((lo + hi) / 2));
  ctx.stroke();

  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  for (const s of series) {
    if (!s.points.length) continue;
    ctx.strokeStyle = style.getPropertyValue(s.color).trim() || s.color;
    ctx.beginPath();
    s.points.forEach(([x, y], i) => (i ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
    ctx.stroke();
  }
}
