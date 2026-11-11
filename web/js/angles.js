// Angle helpers. All angles are in degrees, measured clockwise from north
// (compass convention) unless stated otherwise.

export const DEG = Math.PI / 180;

/** Normalize an angle to [0, 360). */
export function normalizeDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

/** Shortest signed rotation from `from` to `to`, in (-180, 180]. */
export function signedDeltaDeg(from, to) {
  let d = normalizeDeg(to - from);
  if (d > 180) d -= 360;
  return d;
}

/** Weighted circular mean of angles. Returns null when the angles cancel out. */
export function circularMeanDeg(angles, weights) {
  let x = 0;
  let y = 0;
  for (let i = 0; i < angles.length; i++) {
    const w = weights ? weights[i] : 1;
    x += w * Math.cos(angles[i] * DEG);
    y += w * Math.sin(angles[i] * DEG);
  }
  if (Math.hypot(x, y) < 1e-9) return null;
  return normalizeDeg(Math.atan2(y, x) / DEG);
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Eight-point compass name for an angle, e.g. 300 -> "NW". */
export function cardinalName(deg) {
  return CARDINALS[Math.round(normalizeDeg(deg) / 45) % 8];
}

/**
 * Human description of where something is relative to the way the user faces.
 * `relative` is the signed angle from the user's heading to the target.
 */
export function relativeDirectionText(relative) {
  const a = Math.abs(relative);
  const side = relative < 0 ? 'left' : 'right';
  if (a <= 15) return 'Straight ahead';
  if (a <= 60) return `Ahead, to the ${side}`;
  if (a <= 120) return `To your ${side}`;
  if (a <= 165) return `Behind you, to the ${side}`;
  return 'Behind you';
}
