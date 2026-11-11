import { DEG, normalizeDeg } from './angles.js';

/** Small seedable PRNG (mulberry32) so tests are repeatable. */
export function createRng(seed = 1) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Bearing (deg from north) and distance from one point to another; x = east, y = north. */
export function bearingAndDistance(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return { bearing: normalizeDeg(Math.atan2(dx, dy) / DEG), distance: Math.hypot(dx, dy) };
}

/**
 * Simulated RSSI: log-distance path loss, minus body shadowing that grows
 * as the user turns away from the transmitter, plus fading and noise.
 */
export function simulatedRssi(device, user, rng, { exponent = 2.2, bodyLoss = 12, noise = 3 } = {}) {
  const { bearing, distance } = bearingAndDistance(user, device);
  const rel = (bearing - user.heading) * DEG;
  const shadow = (bodyLoss * (1 - Math.cos(rel))) / 2;
  const pathLoss = 10 * exponent * Math.log10(Math.max(distance, 0.3));
  device.fade = 0.85 * (device.fade ?? 0) + 0.5 * gaussian(rng);
  const rssi = device.rssiAt1m - pathLoss - shadow + device.fade + noise * gaussian(rng);
  return Math.round(Math.max(-100, Math.min(-25, rssi)));
}

const DEMO_DEVICES = [
  { name: 'Demo Earbuds', distance: 7, manufacturerIds: [0x004c], interval: 180 },
  { name: 'Demo Key Tag', distance: 13, manufacturerIds: [0x0059], interval: 300 },
  { name: 'Demo Watch', distance: 4, manufacturerIds: [0x0087], interval: 250 },
  { name: 'Demo Speaker', distance: 18, manufacturerIds: [0x009e], interval: 200 },
  { name: '', distance: 10, manufacturerIds: [0x0075], interval: 350 },
  { name: '', distance: 22, manufacturerIds: [0x0006], interval: 400 },
];

/**
 * A pretend room full of Bluetooth devices around the user, for trying the
 * app without hardware. Emits "advertisement" events like the real sources.
 */
export class SimulatedSource extends EventTarget {
  constructor({ seed = Date.now(), getHeading = () => 0, now = () => performance.now() } = {}) {
    super();
    this.rng = createRng(seed);
    this.getHeading = getHeading;
    this.now = now;
    this.user = { x: 0, y: 0, heading: 0 };
    this.timers = [];
    this.devices = DEMO_DEVICES.map((spec, i) => {
      const bearing = this.rng() * 360;
      return {
        id: `demo-${i + 1}`,
        name: spec.name,
        manufacturerIds: spec.manufacturerIds,
        interval: spec.interval,
        rssiAt1m: -56 - Math.round(this.rng() * 8),
        x: spec.distance * Math.sin(bearing * DEG),
        y: spec.distance * Math.cos(bearing * DEG),
        fade: 0,
      };
    });
  }

  get active() {
    return this.timers.length > 0;
  }

  /** Emit one advertisement for a device right now. */
  advertise(device) {
    this.user.heading = this.getHeading() ?? 0;
    const rssi = simulatedRssi(device, this.user, this.rng);
    const ad = {
      id: device.id,
      name: device.name,
      rssi,
      txPower: null,
      manufacturerIds: device.manufacturerIds,
      uuids: [],
      t: this.now(),
      source: 'demo',
    };
    this.dispatchEvent(new CustomEvent('advertisement', { detail: ad }));
    return ad;
  }

  start() {
    this.stop();
    this.timers = this.devices.map((device, i) => {
      const tick = () => {
        this.advertise(device);
        this.timers[i] = setTimeout(tick, device.interval * (0.7 + this.rng() * 0.6));
      };
      return setTimeout(tick, this.rng() * device.interval);
    });
  }

  stop() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  /** Walk `metres` in the direction the user faces (negative = backwards). */
  step(metres = 1) {
    const heading = this.getHeading() ?? 0;
    this.user.x += metres * Math.sin(heading * DEG);
    this.user.y += metres * Math.cos(heading * DEG);
  }

  /** Ground truth, for the "show true direction" option. */
  truth(id) {
    const device = this.devices.find((d) => d.id === id);
    return device ? bearingAndDistance(this.user, device) : null;
  }
}
