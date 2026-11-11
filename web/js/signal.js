// Signal-strength helpers: smoothing, distance and trend.

/** Default received power at 1 m for a typical BLE device. */
export const DEFAULT_RSSI_AT_1M = -59;
/** Path-loss exponent: 2 in free space, roughly 2-3 indoors. */
export const DEFAULT_PATH_LOSS_EXPONENT = 2.5;

/** True when an RSSI reading is usable (Bluetooth uses 127 for "not available"). */
export function isValidRssi(rssi) {
  return Number.isFinite(rssi) && rssi > -130 && rssi < 20;
}

/**
 * One-dimensional Kalman filter for RSSI. The process noise grows with the
 * time between readings, so irregular advertisement intervals are handled.
 */
export class RssiKalman {
  /**
   * @param {object} [options]
   * @param {number} [options.processNoise] variance added per second (dB²/s)
   * @param {number} [options.measurementNoise] variance of one reading (dB²)
   */
  constructor({ processNoise = 4, measurementNoise = 16 } = {}) {
    this.q = processNoise;
    this.r = measurementNoise;
    this.reset();
  }

  reset() {
    this.value = null;
    this.variance = null;
    this.lastT = null;
  }

  /** Add a reading taken at time `t` (ms) and return the smoothed value. */
  update(rssi, t) {
    if (this.value === null) {
      this.value = rssi;
      this.variance = this.r;
    } else {
      const dt = Math.max(0, (t - this.lastT) / 1000);
      const predicted = this.variance + this.q * dt;
      const gain = predicted / (predicted + this.r);
      this.value += gain * (rssi - this.value);
      this.variance = (1 - gain) * predicted;
    }
    this.lastT = t;
    return this.value;
  }
}

/**
 * Received power expected at 1 m. Uses the advertised TX power when present
 * (free-space loss at 1 m on 2.4 GHz is about 41 dB), otherwise a default.
 */
export function rssiAt1m(txPower) {
  if (!Number.isFinite(txPower)) return DEFAULT_RSSI_AT_1M;
  return Math.min(-45, Math.max(-75, txPower - 41));
}

/** Log-distance path-loss model: estimated distance in metres. */
export function estimateDistance(rssi, { rssiAt1m: p1m = DEFAULT_RSSI_AT_1M, exponent = DEFAULT_PATH_LOSS_EXPONENT } = {}) {
  if (!Number.isFinite(rssi)) return null;
  return 10 ** ((p1m - rssi) / (10 * exponent));
}

/** Short, deliberately vague label for a distance estimate. */
export function distanceLabel(metres) {
  if (!Number.isFinite(metres)) return '—';
  if (metres < 0.5) return 'Right here';
  if (metres < 1.5) return 'About 1 m';
  if (metres < 10) return `About ${Math.round(metres)} m`;
  if (metres < 30) return `About ${Math.round(metres / 5) * 5} m`;
  return 'Far away (30 m+)';
}

/** 0..1 signal quality for bars and sounds (-100 dBm -> 0, -40 dBm -> 1). */
export function signalQuality(rssi) {
  if (!Number.isFinite(rssi)) return 0;
  return Math.min(1, Math.max(0, (rssi + 100) / 60));
}

/**
 * Least-squares slope of RSSI over time, in dB per second, using readings
 * from the last `windowMs`, with its standard error. Returns null when there
 * is too little data.
 * @param {{t: number, rssi: number}[]} samples ordered by time
 * @returns {{slope: number, stderr: number} | null}
 */
export function rssiTrend(samples, now, windowMs = 6000) {
  const recent = samples.filter((s) => s.t >= now - windowMs);
  if (recent.length < 5) return null;
  const span = recent[recent.length - 1].t - recent[0].t;
  if (span < 2000) return null;
  const n = recent.length;
  let mt = 0, mr = 0;
  for (const s of recent) { mt += s.t; mr += s.rssi; }
  mt /= n;
  mr /= n;
  let num = 0, den = 0;
  for (const s of recent) {
    num += (s.t - mt) * (s.rssi - mr);
    den += (s.t - mt) ** 2;
  }
  if (den <= 0) return null;
  const slope = num / den;
  let ssr = 0;
  for (const s of recent) ssr += (s.rssi - mr - slope * (s.t - mt)) ** 2;
  const stderr = Math.sqrt(ssr / (n - 2) / den);
  return { slope: slope * 1000, stderr: stderr * 1000 };
}

/**
 * "warmer" / "colder" only when the change is clearly larger than the noise
 * (RSSI jumps by several dB between readings); otherwise "steady".
 */
export function trendLabel(trend) {
  if (!trend) return null;
  const { slope, stderr } = trend;
  const significant = Math.abs(slope) > 0.3 && Math.abs(slope) > 2.5 * stderr;
  if (!significant) return 'steady';
  return slope > 0 ? 'warmer' : 'colder';
}
