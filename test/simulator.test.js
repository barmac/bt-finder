import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimulatedSource, bearingAndDistance, createRng, simulatedRssi } from '../web/js/simulator.js';
import { DirectionEstimator } from '../web/js/direction.js';
import { DeviceRegistry } from '../web/js/devices.js';
import { signedDeltaDeg } from '../web/js/angles.js';

test('createRng is repeatable', () => {
  const a = createRng(42);
  const b = createRng(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

test('bearingAndDistance uses compass bearings', () => {
  const origin = { x: 0, y: 0 };
  assert.deepEqual(bearingAndDistance(origin, { x: 0, y: 5 }), { bearing: 0, distance: 5 });
  assert.equal(bearingAndDistance(origin, { x: 3, y: 0 }).bearing, 90);
  assert.equal(bearingAndDistance(origin, { x: 0, y: -1 }).bearing, 180);
  assert.equal(bearingAndDistance(origin, { x: -2, y: 0 }).bearing, 270);
});

test('simulated signal is stronger facing the device and closer to it', () => {
  const rng = createRng(1);
  const device = { x: 0, y: 8, rssiAt1m: -59 };
  const avg = (user) => {
    let sum = 0;
    for (let i = 0; i < 300; i++) sum += simulatedRssi(device, user, rng);
    return sum / 300;
  };
  const facing = avg({ x: 0, y: 0, heading: 0 });
  const away = avg({ x: 0, y: 0, heading: 180 });
  const closer = avg({ x: 0, y: 6, heading: 0 });
  assert.ok(facing - away > 8, `facing ${facing} vs away ${away}`);
  assert.ok(closer > facing + 5, `closer ${closer} vs ${facing}`);
});

test('end to end: turning in the demo world points at each device', () => {
  const errors = [];
  for (let seed = 1; seed <= 15; seed++) {
    let heading = 0;
    let now = 0;
    const sim = new SimulatedSource({ seed, getHeading: () => heading, now: () => now });
    const registry = new DeviceRegistry();
    sim.addEventListener('advertisement', (event) => registry.ingest(event.detail));

    for (const device of sim.devices) {
      const estimator = new DirectionEstimator();
      // One full turn in 15 s, advertisements at the device's interval.
      for (now = 0; now < 15000; now += device.interval) {
        heading = (now / 15000) * 360;
        const ad = sim.advertise(device);
        estimator.addSample(heading, ad.rssi, now);
      }
      const est = estimator.estimate(now);
      assert.equal(est.status, 'ok', `seed ${seed} ${device.id}: ${est.status}`);
      errors.push(Math.abs(signedDeltaDeg(sim.truth(device.id).bearing, est.bearing)));
    }
    assert.equal(registry.devices.size, sim.devices.length);
  }
  errors.sort((a, b) => a - b);
  const median = errors[Math.floor(errors.length / 2)];
  assert.ok(median < 12, `median error ${median.toFixed(1)}°`);
  assert.ok(errors[errors.length - 1] < 60, `worst error ${errors[errors.length - 1].toFixed(1)}°`);
});

test('stepping moves the user the way they face', () => {
  let heading = 90;
  const sim = new SimulatedSource({ seed: 3, getHeading: () => heading });
  sim.step(2);
  assert.ok(Math.abs(sim.user.x - 2) < 1e-9 && Math.abs(sim.user.y) < 1e-9);
  heading = 0;
  sim.step(-1);
  assert.ok(Math.abs(sim.user.y + 1) < 1e-9);
});
