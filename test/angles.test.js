import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDeg, signedDeltaDeg, circularMeanDeg, cardinalName, relativeDirectionText } from '../web/js/angles.js';

test('normalizeDeg wraps into [0, 360)', () => {
  assert.equal(normalizeDeg(0), 0);
  assert.equal(normalizeDeg(360), 0);
  assert.equal(normalizeDeg(-10), 350);
  assert.equal(normalizeDeg(725), 5);
});

test('signedDeltaDeg takes the short way round', () => {
  assert.equal(signedDeltaDeg(350, 10), 20);
  assert.equal(signedDeltaDeg(10, 350), -20);
  assert.equal(signedDeltaDeg(0, 180), 180);
  assert.equal(signedDeltaDeg(90, 45), -45);
});

test('circularMeanDeg handles wrap-around north', () => {
  assert.ok(Math.abs(signedDeltaDeg(circularMeanDeg([350, 10]), 0)) < 1e-9);
  assert.ok(Math.abs(circularMeanDeg([80, 100]) - 90) < 1e-9);
  assert.equal(circularMeanDeg([0, 180]), null);
});

test('cardinalName', () => {
  assert.equal(cardinalName(0), 'N');
  assert.equal(cardinalName(44), 'NE');
  assert.equal(cardinalName(300), 'NW');
  assert.equal(cardinalName(359), 'N');
});

test('relativeDirectionText', () => {
  assert.equal(relativeDirectionText(5), 'Straight ahead');
  assert.equal(relativeDirectionText(-40), 'Ahead, to the left');
  assert.equal(relativeDirectionText(90), 'To your right');
  assert.equal(relativeDirectionText(-140), 'Behind you, to the left');
  assert.equal(relativeDirectionText(178), 'Behind you');
});
