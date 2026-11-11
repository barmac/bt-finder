import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headingFromOrientation, headingFromWebkitCompass } from '../web/js/orientation-math.js';
import { signedDeltaDeg } from '../web/js/angles.js';

const close = (actual, expected, tolerance = 0.01) =>
  assert.ok(Math.abs(signedDeltaDeg(expected, actual)) <= tolerance, `expected ~${expected}, got ${actual}`);

// Reference: compass heading of the camera direction, from the W3C
// DeviceOrientation spec example (valid when the phone is upright).
function w3cCompassHeading(alpha, beta, gamma) {
  const d = Math.PI / 180;
  const cX = Math.cos(beta * d), cY = Math.cos(gamma * d), cZ = Math.cos(alpha * d);
  const sX = Math.sin(beta * d), sY = Math.sin(gamma * d), sZ = Math.sin(alpha * d);
  const vx = -cZ * sY - sZ * sX * cY;
  const vy = -sZ * sY + cZ * sX * cY;
  let h = Math.atan(vx / vy);
  if (vy < 0) h += Math.PI;
  else if (vx < 0) h += 2 * Math.PI;
  return h / d;
}

test('phone lying flat: heading is where the top edge points', () => {
  close(headingFromOrientation(0, 0, 0), 0);
  // alpha grows anticlockwise, compass headings grow clockwise.
  close(headingFromOrientation(90, 0, 0), 270);
  close(headingFromOrientation(270, 0, 0), 90);
  close(headingFromOrientation(30, 0, 0), 330);
});

test('rolling a flat phone sideways does not change the heading', () => {
  close(headingFromOrientation(0, 0, 30), 0);
  close(headingFromOrientation(90, 0, -40), 270);
});

test('tilting the phone up keeps the same heading', () => {
  for (const beta of [15, 45, 70, 89, 90]) {
    close(headingFromOrientation(60, beta, 0), 300);
  }
});

test('upright phone matches the W3C camera-direction formula', () => {
  for (const [alpha, gamma] of [[0, 0], [45, 0], [200, 10], [300, -15]]) {
    close(headingFromOrientation(alpha, 90, gamma), w3cCompassHeading(alpha, 90, gamma), 0.5);
  }
});

test('landscape screen rotation is applied', () => {
  // Rotated 90° anticlockwise: the right edge of the device is now the top of the screen.
  close(headingFromOrientation(0, 0, 0, 90), 90);
  close(headingFromOrientation(0, 0, 0, 270), 270);
});

test('invalid readings give null', () => {
  assert.equal(headingFromOrientation(null, 0, 0), null);
  assert.equal(headingFromOrientation(0, NaN, 0), null);
});

test('webkitCompassHeading is corrected for screen rotation', () => {
  close(headingFromWebkitCompass(350, 0), 350);
  close(headingFromWebkitCompass(350, 90), 80);
  assert.equal(headingFromWebkitCompass(undefined), null);
});
