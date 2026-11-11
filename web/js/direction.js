import { DEG, normalizeDeg, circularMeanDeg } from './angles.js';

/**
 * Estimates the bearing to a Bluetooth transmitter from (heading, RSSI)
 * samples collected while the user turns around in place.
 *
 * Method: the user's body absorbs a lot of 2.4 GHz energy, so with the phone
 * held in front of the chest the signal is strongest when facing the
 * transmitter and weakest when facing away. Samples are averaged into
 * heading bins and a sinusoid  rssi(θ) = c + a·cos θ + b·sin θ  is fitted by
 * weighted least squares. Its peak, atan2(b, a), is the estimated bearing;
 * the fit's covariance gives an uncertainty in degrees.
 */
export class DirectionEstimator {
  /**
   * @param {object} [options]
   * @param {number} [options.binCount] heading bins around the circle
   * @param {number} [options.windowMs] samples older than this are forgotten
   * @param {number} [options.minSpanDeg] how much of the circle must be covered
   * @param {number} [options.maxBinWeight] cap so one bin cannot dominate
   */
  constructor({ binCount = 24, windowMs = 30000, minSpanDeg = 180, maxBinWeight = 8 } = {}) {
    this.binCount = binCount;
    this.binWidth = 360 / binCount;
    this.windowMs = windowMs;
    this.minSpanDeg = minSpanDeg;
    this.maxBinWeight = maxBinWeight;
    this.samples = [];
  }

  reset() {
    this.samples = [];
  }

  /** Record one RSSI reading taken while facing `heading` at time `t` (ms). */
  addSample(heading, rssi, t) {
    if (!Number.isFinite(heading) || !Number.isFinite(rssi) || !Number.isFinite(t)) return;
    this.samples.push({ heading: normalizeDeg(heading), rssi, t });
    this.#prune(t);
  }

  #prune(now) {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.samples.length && this.samples[i].t < cutoff) i++;
    if (i > 0) this.samples.splice(0, i);
  }

  /** Per-bin statistics; `count` is 0 for bins with no samples. */
  bins(now) {
    if (Number.isFinite(now)) this.#prune(now);
    const groups = Array.from({ length: this.binCount }, () => []);
    for (const s of this.samples) {
      const index = Math.floor(s.heading / this.binWidth) % this.binCount;
      groups[index].push(s);
    }
    return groups.map((group, index) => {
      const center = (index + 0.5) * this.binWidth;
      if (group.length === 0) return { index, center, heading: center, count: 0, mean: null };
      const mean = group.reduce((sum, s) => sum + s.rssi, 0) / group.length;
      const heading = circularMeanDeg(group.map((s) => s.heading)) ?? center;
      return { index, center, heading, count: group.length, mean };
    });
  }

  /** Angular span of the circle covered by samples, in degrees. */
  #coveredSpan(filled) {
    if (filled.length === 0) return 0;
    const centers = filled.map((b) => b.center).sort((p, q) => p - q);
    let maxGap = 360 - centers[centers.length - 1] + centers[0];
    for (let i = 1; i < centers.length; i++) maxGap = Math.max(maxGap, centers[i] - centers[i - 1]);
    return Math.min(360, 360 - maxGap + this.binWidth);
  }

  /**
   * Current estimate. `status` is one of:
   *  - "no-data":  nothing recorded yet
   *  - "turn":     not enough of the circle covered; keep turning
   *  - "unclear":  covered, but no clear strongest direction
   *  - "ok":       `bearing` ± `uncertainty` degrees is usable
   */
  estimate(now) {
    const bins = this.bins(now);
    const filled = bins.filter((b) => b.count > 0);
    const span = this.#coveredSpan(filled);
    const base = { bins, coverage: span / 360, sampleCount: this.samples.length };

    if (filled.length === 0) return { ...base, status: 'no-data' };
    if (span < this.minSpanDeg || filled.length < 5) return { ...base, status: 'turn' };

    const fit = fitSinusoid(
      filled.map((b) => b.heading),
      filled.map((b) => b.mean),
      filled.map((b) => Math.min(b.count, this.maxBinWeight)),
    );
    if (!fit) return { ...base, status: 'unclear' };

    const strongest = filled.reduce((best, b) => (b.mean > best.mean ? b : best));
    const weakest = filled.reduce((worst, b) => (b.mean < worst.mean ? b : worst));
    const result = {
      ...base,
      bearing: fit.bearing,
      uncertainty: fit.uncertainty,
      amplitude: fit.amplitude,
      residual: fit.residual,
      strongestRssi: strongest.mean,
      contrast: strongest.mean - weakest.mean,
    };
    const clear = fit.amplitude >= 1.5 && fit.uncertainty <= 75;
    return { ...result, status: clear ? 'ok' : 'unclear' };
  }
}

/**
 * Weighted least-squares fit of y = c + a·cos θ + b·sin θ.
 * Returns the peak bearing, amplitude (dB), residual std (dB) and a 1-sigma
 * uncertainty of the bearing in degrees; null if the system is singular.
 */
export function fitSinusoid(anglesDeg, values, weights) {
  const n = anglesDeg.length;
  if (n < 4) return null;
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const v = [0, 0, 0];
  const rows = anglesDeg.map((deg) => [1, Math.cos(deg * DEG), Math.sin(deg * DEG)]);
  let weightSum = 0;
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i] : 1;
    weightSum += w;
    for (let r = 0; r < 3; r++) {
      v[r] += w * rows[i][r] * values[i];
      for (let c = 0; c < 3; c++) M[r][c] += w * rows[i][r] * rows[i][c];
    }
  }
  const inv = invert3(M);
  if (!inv) return null;
  const beta = [0, 1, 2].map((r) => inv[r][0] * v[0] + inv[r][1] * v[1] + inv[r][2] * v[2]);
  const [, a, b] = beta;
  const amplitude = Math.hypot(a, b);

  let ssr = 0;
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i] : 1;
    const predicted = beta[0] + a * rows[i][1] + b * rows[i][2];
    ssr += w * (values[i] - predicted) ** 2;
  }
  // Noise variance of a single reading. Floored at 2 dB, because real RSSI is
  // never that clean and consecutive readings are correlated.
  const sigma2 = Math.max(ssr / (n - 3), 4);

  let uncertainty = 180;
  if (amplitude > 1e-9) {
    // Delta method: variance of atan2(b, a) from the covariance sigma² · M⁻¹.
    const varA = sigma2 * inv[1][1];
    const varB = sigma2 * inv[2][2];
    const cov = sigma2 * inv[1][2];
    const varPhi = (b * b * varA + a * a * varB - 2 * a * b * cov) / amplitude ** 4;
    // Inflate by 30%: readings close in time share fading, so they carry
    // less independent information than the formula assumes.
    uncertainty = Math.min(180, Math.max(5, (1.3 * Math.sqrt(varPhi)) / DEG));
  }

  return {
    bearing: normalizeDeg(Math.atan2(b, a) / DEG),
    amplitude,
    offset: beta[0],
    residual: Math.sqrt(ssr / weightSum),
    uncertainty,
  };
}

function invert3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-9) return null;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}
