import { DEG, normalizeDeg } from './angles.js';

/**
 * Device axes expressed in the Earth frame (x = East, y = North, z = Up) for a
 * DeviceOrientationEvent reading. The W3C spec defines the rotation as
 * R = Rz(alpha) * Rx(beta) * Ry(gamma); the columns of R are the device axes.
 */
export function deviceAxes(alpha, beta, gamma) {
  const a = alpha * DEG;
  const b = beta * DEG;
  const g = gamma * DEG;
  const cA = Math.cos(a), sA = Math.sin(a);
  const cB = Math.cos(b), sB = Math.sin(b);
  const cG = Math.cos(g), sG = Math.sin(g);
  return {
    x: [cA * cG - sA * sB * sG, sA * cG + cA * sB * sG, -cB * sG],
    y: [-sA * cB, cA * cB, sB],
    z: [cA * sG + sA * sB * cG, sA * sG - cA * sB * cG, cB * cG],
  };
}

/**
 * Compass heading (degrees clockwise from north) of the direction the user is
 * pointing the phone, from an absolute DeviceOrientationEvent reading.
 *
 * It follows the top edge of the screen while the phone is flat or tilted,
 * and blends in the camera (back) direction as the phone is raised upright,
 * where the top edge points at the sky and stops carrying a direction.
 *
 * `screenAngle` is screen.orientation.angle, so landscape works too.
 * Returns null for readings that do not define a direction.
 */
export function headingFromOrientation(alpha, beta, gamma, screenAngle = 0) {
  if (![alpha, beta, gamma].every(Number.isFinite)) return null;
  const { x, y, z } = deviceAxes(alpha, beta, gamma);
  const t = screenAngle * DEG;
  const st = Math.sin(t), ct = Math.cos(t);
  // Unit vector pointing to the top edge of the screen as the user sees it.
  const up = [x[0] * st + y[0] * ct, x[1] * st + y[1] * ct, x[2] * st + y[2] * ct];
  // Weight of the camera direction: 0 when flat, 1 when the top edge points straight up.
  const w = Math.max(0, up[2]);
  const east = up[0] - w * z[0];
  const north = up[1] - w * z[1];
  if (Math.hypot(east, north) < 1e-6) return null;
  return normalizeDeg(Math.atan2(east, north) / DEG);
}

/** Heading from Safari's webkitCompassHeading, corrected for screen rotation. */
export function headingFromWebkitCompass(webkitCompassHeading, screenAngle = 0) {
  if (!Number.isFinite(webkitCompassHeading)) return null;
  return normalizeDeg(webkitCompassHeading + screenAngle);
}
