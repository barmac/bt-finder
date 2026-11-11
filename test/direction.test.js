import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DirectionEstimator, fitSinusoid } from '../web/js/direction.js';
import { signedDeltaDeg, DEG } from '../web/js/angles.js';
import { createRng } from '../web/js/simulator.js';

function gaussian(rng) {
  return Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-12))) * Math.cos(2 * Math.PI * rng());
}

/** Simulate one slow full turn: samples every `stepDeg`, body shadow pattern + noise. */
function sweep(estimator, { bearing, rng, noise = 3, amplitude = 6, from = 0, turn = 360, stepDeg = 4, t0 = 0 }) {
  let t = t0;
  for (let a = 0; a < turn; a += stepDeg) {
    const heading = from + a;
    const rssi = -70 + amplitude * Math.cos((heading - bearing) * DEG) + noise * gaussian(rng);
    estimator.addSample(heading, rssi, t);
    t += 150;
  }
  return t;
}

test('fitSinusoid recovers an exact cosine', () => {
  const angles = Array.from({ length: 12 }, (_, i) => i * 30);
  const values = angles.map((a) => -65 + 5 * Math.cos((a - 123) * DEG));
  const fit = fitSinusoid(angles, values);
  assert.ok(Math.abs(signedDeltaDeg(fit.bearing, 123)) < 1e-6);
  assert.ok(Math.abs(fit.amplitude - 5) < 1e-6);
  assert.ok(Math.abs(fit.offset + 65) < 1e-6);
  assert.ok(fit.residual < 1e-6);
});

test('fitSinusoid refuses degenerate input', () => {
  assert.equal(fitSinusoid([0, 0, 0, 0], [-60, -61, -62, -63]), null);
  assert.equal(fitSinusoid([0, 90, 180], [-60, -61, -62]), null);
});

test('no samples means no estimate', () => {
  const estimator = new DirectionEstimator();
  assert.equal(estimator.estimate(0).status, 'no-data');
});

test('a partial turn asks the user to keep turning', () => {
  const estimator = new DirectionEstimator();
  const t = sweep(estimator, { bearing: 200, rng: createRng(1), turn: 120 });
  const est = estimator.estimate(t);
  assert.equal(est.status, 'turn');
  assert.ok(est.coverage > 0.3 && est.coverage < 0.5, `coverage ${est.coverage}`);
});

test('a full turn finds the bearing, including near north', () => {
  for (const bearing of [0, 5, 90, 187, 271, 355]) {
    const estimator = new DirectionEstimator();
    const t = sweep(estimator, { bearing, rng: createRng(bearing + 11) });
    const est = estimator.estimate(t);
    assert.equal(est.status, 'ok');
    const error = Math.abs(signedDeltaDeg(bearing, est.bearing));
    assert.ok(error < 15, `bearing ${bearing}: estimated ${est.bearing.toFixed(1)}`);
    assert.ok(est.uncertainty < 25, `uncertainty ${est.uncertainty}`);
    assert.ok(est.coverage > 0.95);
  }
});

test('the reported uncertainty is honest across many trials', () => {
  let inside = 0;
  const trials = 200;
  for (let i = 0; i < trials; i++) {
    const rng = createRng(1000 + i);
    const bearing = rng() * 360;
    const estimator = new DirectionEstimator();
    const t = sweep(estimator, { bearing, rng, noise: 4, amplitude: 4, stepDeg: 6 });
    const est = estimator.estimate(t);
    if (est.status === 'ok' && Math.abs(signedDeltaDeg(bearing, est.bearing)) <= 2 * est.uncertainty) inside++;
  }
  // A 2-sigma interval should contain the truth roughly 95% of the time.
  assert.ok(inside / trials > 0.85, `only ${inside}/${trials} inside 2 sigma`);
});

test('uneven turning speed does not bias the estimate', () => {
  const estimator = new DirectionEstimator();
  const rng = createRng(5);
  let t = 0;
  // Linger facing 90° (away from the device at 270°), then turn the rest quickly.
  for (let i = 0; i < 80; i++) {
    estimator.addSample(90 + (rng() - 0.5) * 10, -76 + 3 * gaussian(rng), t);
    t += 100;
  }
  t = sweep(estimator, { bearing: 270, rng, stepDeg: 12, t0: t });
  const est = estimator.estimate(t);
  assert.equal(est.status, 'ok');
  assert.ok(Math.abs(signedDeltaDeg(270, est.bearing)) < 20, `estimated ${est.bearing}`);
});

test('a signal with no direction is reported as unclear', () => {
  const estimator = new DirectionEstimator();
  const t = sweep(estimator, { bearing: 0, amplitude: 0, noise: 3, rng: createRng(3) });
  assert.equal(estimator.estimate(t).status, 'unclear');
});

test('old samples are forgotten', () => {
  const estimator = new DirectionEstimator({ windowMs: 10000 });
  const t = sweep(estimator, { bearing: 45, rng: createRng(9) });
  assert.equal(estimator.estimate(t).status, 'ok');
  assert.equal(estimator.estimate(t + 20000).status, 'no-data');
});

test('bins report counts and means', () => {
  const estimator = new DirectionEstimator({ binCount: 4 });
  estimator.addSample(10, -60, 0);
  estimator.addSample(20, -70, 1);
  estimator.addSample(200, -80, 2);
  const bins = estimator.bins(2);
  assert.equal(bins[0].count, 2);
  assert.equal(bins[0].mean, -65);
  assert.equal(bins[1].count, 0);
  assert.equal(bins[2].count, 1);
});
