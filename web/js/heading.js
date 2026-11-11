import { DEG, normalizeDeg } from './angles.js';
import { headingFromOrientation, headingFromWebkitCompass } from './orientation-math.js';

function screenAngle() {
  if (typeof screen !== 'undefined' && screen.orientation && Number.isFinite(screen.orientation.angle)) {
    return screen.orientation.angle;
  }
  return Number.isFinite(window.orientation) ? window.orientation : 0;
}

/**
 * Which way the user is facing. Uses the phone's compass when there is one,
 * and otherwise a value set by hand (drag the dial, arrow keys, slider).
 * Emits "change" whenever the heading changes.
 */
export class HeadingProvider extends EventTarget {
  constructor() {
    super();
    this.mode = 'manual';
    this.heading = 0;
    this.compassAvailable = false;
    this.lastCompassT = 0;
    this.smoothX = null;
    this.smoothY = null;
    this.onOrientation = (event) => this.#handleOrientation(event);
    this.listening = false;
  }

  /**
   * Start listening to the compass. On iOS this must run inside a user
   * gesture. Resolves to true if a reading arrived within `timeoutMs`.
   */
  async startCompass(timeoutMs = 1500) {
    if (typeof window === 'undefined' || typeof DeviceOrientationEvent === 'undefined') return false;
    if (this.compassAvailable) return true;
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      // iOS needs this inside a tap; newer Chrome also has it but may answer
      // "prompt" while still delivering events. Only an explicit "denied" is
      // final; otherwise keep listening and let real readings decide.
      try {
        const state = await DeviceOrientationEvent.requestPermission();
        if (state === 'denied') return false;
      } catch {
        // No user gesture yet; the next button press asks again.
      }
    }
    if (!this.listening) {
      if ('ondeviceorientationabsolute' in window) {
        window.addEventListener('deviceorientationabsolute', this.onOrientation);
      }
      window.addEventListener('deviceorientation', this.onOrientation);
      this.listening = true;
    }
    if (this.compassAvailable) return true;
    return new Promise((resolve) => {
      const done = () => {
        this.removeEventListener('compass', done);
        clearTimeout(timer);
        resolve(this.compassAvailable);
      };
      const timer = setTimeout(done, timeoutMs);
      this.addEventListener('compass', done);
    });
  }

  #handleOrientation(event) {
    let heading = null;
    if (Number.isFinite(event.webkitCompassHeading)) {
      heading = headingFromWebkitCompass(event.webkitCompassHeading, screenAngle());
    } else if (event.type === 'deviceorientationabsolute' || event.absolute === true) {
      heading = headingFromOrientation(event.alpha, event.beta, event.gamma, screenAngle());
    }
    if (heading === null) return;
    const now = performance.now();
    this.lastCompassT = now;
    if (!this.compassAvailable) {
      this.compassAvailable = true;
      this.mode = 'compass';
      this.dispatchEvent(new Event('compass'));
    }
    if (this.mode !== 'compass') return;
    this.#setSmoothed(heading);
  }

  // Low-pass filter on the unit vector so the dial does not jitter and
  // wrapping around north is handled correctly.
  #setSmoothed(heading) {
    const x = Math.cos(heading * DEG);
    const y = Math.sin(heading * DEG);
    if (this.smoothX === null) {
      this.smoothX = x;
      this.smoothY = y;
    } else {
      const k = 0.25;
      this.smoothX += k * (x - this.smoothX);
      this.smoothY += k * (y - this.smoothY);
    }
    this.#emit(normalizeDeg(Math.atan2(this.smoothY, this.smoothX) / DEG));
  }

  /** True if the compass is giving fresh readings. */
  get compassLive() {
    return this.mode === 'compass' && performance.now() - this.lastCompassT < 1000;
  }

  /** Use the compass if there is one, otherwise stay in manual mode. */
  useCompass() {
    if (this.compassAvailable) this.mode = 'compass';
  }

  /** Switch to manual mode and set the heading by hand. */
  setManual(heading) {
    this.mode = 'manual';
    this.#emit(normalizeDeg(heading));
  }

  /** Current heading, or null if the compass stopped reporting. */
  current() {
    if (this.mode === 'compass' && !this.compassLive) return null;
    return this.heading;
  }

  #emit(heading) {
    this.heading = heading;
    this.dispatchEvent(new CustomEvent('change', { detail: { heading, mode: this.mode } }));
  }
}
