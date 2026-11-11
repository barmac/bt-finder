/**
 * Geiger-counter style feedback: beeps get faster and higher as the signal
 * gets stronger, so you can search without looking at the screen.
 */
export class Beeper {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.level = null;
    this.timer = null;
  }

  /** Must be called from a user gesture so audio is allowed to start. */
  async enable() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;
    this.ctx ??= new AudioCtx();
    await this.ctx.resume();
    if (!this.enabled) {
      this.enabled = true;
      this.#tick();
    }
    return true;
  }

  disable() {
    this.enabled = false;
    clearTimeout(this.timer);
  }

  /** Signal quality 0..1, or null when there is no fresh signal. */
  setLevel(level) {
    this.level = level;
  }

  #tick() {
    if (!this.enabled) return;
    const level = this.level;
    if (level !== null) this.#blip(level);
    const interval = level === null ? 800 : 1100 - 1000 * level;
    this.timer = setTimeout(() => this.#tick(), interval);
  }

  #blip(level) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 480 + 720 * level;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.2, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.07);
  }
}
