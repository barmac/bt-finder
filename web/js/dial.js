import { DEG } from './angles.js';

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (parent) parent.appendChild(node);
  return node;
}

function point(r, deg) {
  return [r * Math.sin(deg * DEG), -r * Math.cos(deg * DEG)];
}

/** SVG path of an annular sector (r0 = 0 gives a pie wedge). Angles clockwise from north. */
export function sectorPath(r0, r1, from, to) {
  const sweep = to - from;
  if (sweep >= 359.9) {
    const outer = `M 0 ${-r1} A ${r1} ${r1} 0 1 1 0 ${r1} A ${r1} ${r1} 0 1 1 0 ${-r1} Z`;
    if (r0 <= 0) return outer;
    return `${outer} M 0 ${-r0} A ${r0} ${r0} 0 1 0 0 ${r0} A ${r0} ${r0} 0 1 0 0 ${-r0} Z`;
  }
  const large = sweep > 180 ? 1 : 0;
  const [x0, y0] = point(r1, from);
  const [x1, y1] = point(r1, to);
  const f = (n) => n.toFixed(2);
  if (r0 <= 0) {
    return `M 0 0 L ${f(x0)} ${f(y0)} A ${r1} ${r1} 0 ${large} 1 ${f(x1)} ${f(y1)} Z`;
  }
  const [x2, y2] = point(r0, to);
  const [x3, y3] = point(r0, from);
  return `M ${f(x0)} ${f(y0)} A ${r1} ${r1} 0 ${large} 1 ${f(x1)} ${f(y1)} L ${f(x2)} ${f(y2)} A ${r0} ${r0} 0 ${large} 0 ${f(x3)} ${f(y3)} Z`;
}

/**
 * Heading-up compass dial. The rose turns so the top of the dial is always
 * the way the user faces; the arrow points to the estimated bearing; the
 * ring of segments shows how strong the signal was in each direction.
 */
export class Dial {
  constructor(svg, { binCount = 24 } = {}) {
    this.svg = svg;
    this.binCount = binCount;
    this.heading = 0;
    svg.setAttribute('viewBox', '-100 -100 200 200');
    svg.replaceChildren();

    el('circle', { r: 97, class: 'dial-face' }, svg);
    this.rose = el('g', { class: 'dial-rose' }, svg);

    const binWidth = 360 / binCount;
    this.segments = [];
    for (let i = 0; i < binCount; i++) {
      const path = el('path', {
        d: sectorPath(60, 71, i * binWidth + 0.8, (i + 1) * binWidth - 0.8),
        class: 'heat empty',
      }, this.rose);
      this.segments.push(path);
    }

    for (let deg = 0; deg < 360; deg += 5) {
      const major = deg % 30 === 0;
      const [x0, y0] = point(major ? 86 : 90, deg);
      const [x1, y1] = point(94, deg);
      el('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: major ? 'tick major' : 'tick' }, this.rose);
    }

    this.labels = [];
    for (const [text, deg] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
      const [x, y] = point(78, deg);
      const label = el('text', { x, y, class: text === 'N' ? 'cardinal north' : 'cardinal', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, this.rose);
      label.textContent = text;
      this.labels.push({ label, x, y });
    }

    this.truth = el('path', { d: 'M 0 -73 L 5 -64 L 0 -58 L -5 -64 Z', class: 'truth', visibility: 'hidden' }, this.rose);

    this.pointer = el('g', { class: 'dial-pointer', visibility: 'hidden' }, svg);
    this.wedge = el('path', { class: 'wedge' }, this.pointer);
    el('path', { d: 'M 0 -54 L 13 -28 L 4.5 -31 L 4.5 12 L -4.5 12 L -4.5 -31 L -13 -28 Z', class: 'arrow' }, this.pointer);

    el('path', { d: 'M -7 -99 L 7 -99 L 0 -87 Z', class: 'facing' }, svg);
    el('circle', { r: 6, class: 'hub' }, svg);
  }

  setHeading(heading) {
    this.heading = heading;
    this.rose.setAttribute('transform', `rotate(${(-heading).toFixed(2)})`);
    for (const { label, x, y } of this.labels) {
      label.setAttribute('transform', `rotate(${heading.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)})`);
    }
    this.#placePointer();
  }

  /**
   * @param {{bearing: number, uncertainty: number} | null} estimate
   * @param {{stale?: boolean}} [options]
   */
  setEstimate(estimate, { stale = false } = {}) {
    this.estimate = estimate;
    if (!estimate) {
      this.pointer.setAttribute('visibility', 'hidden');
      return;
    }
    const u = Math.min(180, Math.max(4, estimate.uncertainty));
    this.wedge.setAttribute('d', sectorPath(0, 56, -u, u));
    this.pointer.setAttribute('visibility', 'visible');
    this.pointer.classList.toggle('stale', stale);
    this.#placePointer();
  }

  #placePointer() {
    if (!this.estimate) return;
    this.pointer.setAttribute('transform', `rotate(${(this.estimate.bearing - this.heading).toFixed(2)})`);
  }

  /** Colour the ring from DirectionEstimator bins. */
  setBins(bins) {
    const means = bins.filter((b) => b.count > 0).map((b) => b.mean);
    const min = Math.min(...means);
    const max = Math.max(...means);
    bins.forEach((bin, i) => {
      const segment = this.segments[i];
      if (!segment) return;
      if (bin.count === 0) {
        segment.setAttribute('class', 'heat empty');
        segment.removeAttribute('style');
        return;
      }
      const v = max - min < 1 ? 0.5 : (bin.mean - min) / (max - min);
      segment.setAttribute('class', 'heat');
      segment.setAttribute('style', `fill-opacity:${(0.15 + 0.85 * v).toFixed(2)}`);
    });
  }

  /** Show the real bearing (demo mode only), or null to hide it. */
  setTruth(bearing) {
    if (bearing === null) {
      this.truth.setAttribute('visibility', 'hidden');
      return;
    }
    this.truth.setAttribute('visibility', 'visible');
    this.truth.setAttribute('transform', `rotate(${bearing.toFixed(2)})`);
  }
}

/** Draw an RSSI history sparkline into an <svg> element. */
export function drawSparkline(svg, history, now, windowMs = 30000) {
  const width = 300;
  const height = 60;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  let line = svg.querySelector('polyline');
  if (!line) line = el('polyline', { class: 'spark' }, svg);
  const points = history.filter((h) => h.t >= now - windowMs);
  if (points.length < 2) {
    line.setAttribute('points', '');
    return;
  }
  const lo = -100;
  const hi = -30;
  const coords = points.map((h) => {
    const x = ((h.t - (now - windowMs)) / windowMs) * width;
    const value = Math.min(hi, Math.max(lo, h.smoothed));
    const y = height - ((value - lo) / (hi - lo)) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  line.setAttribute('points', coords.join(' '));
}
