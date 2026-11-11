import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RssiKalman, estimateDistance, rssiAt1m, distanceLabel, rssiTrend, trendLabel, isValidRssi, signalQuality,
} from '../web/js/signal.js';
import { createRng } from '../web/js/simulator.js';

test('isValidRssi rejects the "not available" value and nonsense', () => {
  assert.equal(isValidRssi(-60), true);
  assert.equal(isValidRssi(127), false);
  assert.equal(isValidRssi(null), false);
  assert.equal(isValidRssi(-200), false);
});

test('Kalman filter smooths noise around the true value', () => {
  const rng = createRng(7);
  const kalman = new RssiKalman();
  let rawError = 0;
  let smoothError = 0;
  for (let i = 0; i < 200; i++) {
    const raw = -70 + (rng() - 0.5) * 16;
    const smooth = kalman.update(raw, i * 200);
    if (i > 20) {
      rawError += Math.abs(raw + 70);
      smoothError += Math.abs(smooth + 70);
    }
  }
  assert.ok(smoothError < rawError / 2, `smoothed error ${smoothError} vs raw ${rawError}`);
});

test('Kalman filter follows a real change', () => {
  const kalman = new RssiKalman();
  for (let i = 0; i < 20; i++) kalman.update(-80, i * 200);
  let value;
  for (let i = 20; i < 60; i++) value = kalman.update(-60, i * 200);
  assert.ok(value > -63, `got ${value}`);
});

test('distance from the log-distance model', () => {
  assert.equal(estimateDistance(-59), 1);
  assert.ok(Math.abs(estimateDistance(-84) - 10) < 1e-9);
  assert.ok(Math.abs(estimateDistance(-79, { rssiAt1m: -59, exponent: 2 }) - 10) < 1e-9);
  assert.equal(estimateDistance(null), null);
});

test('rssiAt1m uses TX power when present, within sane limits', () => {
  assert.equal(rssiAt1m(undefined), -59);
  assert.equal(rssiAt1m(-12), -53);
  assert.equal(rssiAt1m(20), -45);
  assert.equal(rssiAt1m(-60), -75);
});

test('distanceLabel', () => {
  assert.equal(distanceLabel(0.3), 'Right here');
  assert.equal(distanceLabel(1.2), 'About 1 m');
  assert.equal(distanceLabel(3.4), 'About 3 m');
  assert.equal(distanceLabel(17), 'About 15 m');
  assert.equal(distanceLabel(80), 'Far away (30 m+)');
});

test('rssiTrend detects getting closer and further', () => {
  const rising = Array.from({ length: 20 }, (_, i) => ({ t: i * 250, rssi: -80 + i * 0.5 }));
  const trend = rssiTrend(rising, 19 * 250);
  assert.ok(Math.abs(trend.slope - 2) < 1e-6, `slope ${trend.slope}`);
  assert.equal(trendLabel(trend), 'warmer');
  const falling = rising.map((s) => ({ ...s, rssi: -s.rssi - 160 }));
  assert.equal(trendLabel(rssiTrend(falling, 19 * 250)), 'colder');
  assert.equal(rssiTrend(rising.slice(0, 3), 500), null);
  assert.equal(trendLabel(null), null);
});

function noisyTrendLabels(slopePerSecond, trials = 300) {
  const rng = createRng(slopePerSecond * 100 + 17);
  const counts = { warmer: 0, colder: 0, steady: 0 };
  for (let k = 0; k < trials; k++) {
    // Six seconds of readings at 5 Hz with ±3 dB noise.
    const samples = Array.from({ length: 30 }, (_, i) => ({
      t: i * 200,
      rssi: -75 + slopePerSecond * i * 0.2 + 3 * Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-12))) * Math.cos(2 * Math.PI * rng()),
    }));
    counts[trendLabel(rssiTrend(samples, 5800))]++;
  }
  return counts;
}

test('noise alone rarely reads as warmer or colder', () => {
  const counts = noisyTrendLabels(0);
  assert.ok(counts.steady / 300 > 0.95, JSON.stringify(counts));
});

test('a real approach through the noise reads as warmer', () => {
  const counts = noisyTrendLabels(2);
  assert.ok(counts.warmer / 300 > 0.9, JSON.stringify(counts));
  assert.equal(counts.colder, 0);
});

test('signalQuality is clamped to 0..1', () => {
  assert.equal(signalQuality(-120), 0);
  assert.equal(signalQuality(-70), 0.5);
  assert.equal(signalQuality(-20), 1);
});
