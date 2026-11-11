import { normalizeDeg, signedDeltaDeg, cardinalName, relativeDirectionText } from './angles.js';
import { DirectionEstimator } from './direction.js';
import { DeviceRegistry, displayName } from './devices.js';
import { estimateDistance, distanceLabel, rssiAt1m, rssiTrend, trendLabel, signalQuality, isValidRssi } from './signal.js';
import { BluetoothSource, detectCapabilities, describeBluetoothError } from './bluetooth.js';
import { NativeBluetoothSource, detectNativeCapabilities, isNativeApp, nativeBluetoothReady } from './native-bluetooth.js';
import { SimulatedSource } from './simulator.js';
import { HeadingProvider } from './heading.js';
import { Dial, drawSparkline } from './dial.js';
import { Beeper } from './beeper.js';

const $ = (id) => document.getElementById(id);
/** Running inside the iPhone app (Capacitor) rather than a browser. */
const NATIVE = isNativeApp();
const FLAG_URL = 'chrome://flags/#enable-experimental-web-platform-features';

// ---------------------------------------------------------------- settings

const SETTINGS_KEY = 'bt-finder:settings';

function loadSettings() {
  const defaults = { namedOnly: false, calibration: {} };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private mode); settings then last for this visit only.
  }
}

// ------------------------------------------------------------------- state

const settings = loadSettings();
const registry = new DeviceRegistry();
const estimator = new DirectionEstimator();
const heading = new HeadingProvider();
const beeper = new Beeper();
const dial = new Dial($('dial'), { binCount: estimator.binCount });

const app = {
  caps: null,
  mode: null, // null | 'bluetooth' | 'demo'
  bt: null,
  sim: null,
  remembered: new Map(), // id -> BluetoothDevice the site has permission for
  selectedId: null,
  selectedAt: 0,
  lastGood: null, // last confident estimate { bearing, uncertainty, t }
  target: null, // what the arrow should show { bearing, uncertainty, stale }
  shownBearing: null, // arrow angle, eased toward target.bearing
  lastInfoAt: 0,
  autoTurn: null,
  showTruth: false,
  sound: false,
  wakeLock: null,
  looping: false,
  headings: [], // recent { t, heading }, to tell turning from walking
  order: [],
  orderAt: 0,
};

// ------------------------------------------------------------------ helpers

function ago(ms) {
  const s = ms / 1000;
  if (s < 1.5) return 'just now';
  if (s < 60) return `${Math.round(s)} s ago`;
  return `${Math.round(s / 60)} min ago`;
}

let toastTimer = null;
function toast(message, isError = false) {
  const node = $('toast');
  node.textContent = message;
  node.classList.toggle('error', isError);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 7000 : 3500);
}

function calibrationFor(device) {
  return settings.calibration[device.id];
}

function distanceFor(device) {
  if (device.smoothed === null) return null;
  return estimateDistance(device.smoothed, { rssiAt1m: calibrationFor(device) ?? rssiAt1m(device.txPower) });
}

function finderVisible() {
  return !$('finder-view').hidden;
}

// ------------------------------------------------------------ data intake

function handleAdvertisement(event) {
  const ad = event.detail;
  const device = registry.ingest(ad);
  if (!device) return;
  if (ad.id === app.selectedId && isValidRssi(ad.rssi)) {
    const facing = heading.current();
    if (facing !== null) estimator.addSample(facing, ad.rssi, ad.t);
  }
  requestListRender();
}

function ensureBluetoothMode() {
  if (app.mode === 'demo') stopDemo();
  if (!app.bt) {
    app.bt = NATIVE ? new NativeBluetoothSource() : new BluetoothSource();
    app.bt.addEventListener('advertisement', handleAdvertisement);
    app.bt.addEventListener('device', (event) => {
      registry.touch(event.detail);
      requestListRender();
    });
  }
  app.mode = 'bluetooth';
}

async function startScan() {
  heading.startCompass().then(updateCapabilityUi);
  try {
    ensureBluetoothMode();
    await app.bt.startScan();
    toast('Scanning. Nearby devices will appear below.');
  } catch (error) {
    toast(describeBluetoothError(error), true);
  }
  // Bluetooth may have been switched on or allowed since launch.
  if (NATIVE) await refreshNativeCapabilities();
  updateModeUi();
}

async function refreshNativeCapabilities() {
  app.caps = await detectNativeCapabilities();
  renderNotice();
  updateModeUi();
  if (app.caps.problem === 'waiting') {
    // Check again as soon as iOS answers (e.g. after the permission prompt).
    nativeBluetoothReady().then(refreshNativeCapabilities, refreshNativeCapabilities);
  }
}

async function pickDevice() {
  heading.startCompass().then(updateCapabilityUi);
  try {
    ensureBluetoothMode();
    const device = await app.bt.pickDevice();
    app.remembered.set(device.id, device);
    registry.touch({ id: device.id, name: device.name || '', source: 'watch' });
    selectDevice(device.id);
  } catch (error) {
    if (error?.name !== 'NotFoundError') toast(describeBluetoothError(error), true);
  }
  updateModeUi();
}

/** Devices the site already has permission for (only with getDevices()). */
async function restoreRemembered() {
  if (!app.caps.getDevices || !app.caps.watch) return;
  ensureBluetoothMode();
  const devices = await app.bt.rememberedDevices();
  for (const device of devices) {
    app.remembered.set(device.id, device);
    registry.touch({ id: device.id, name: device.name || '', source: 'remembered' });
    app.bt.watchDevice(device).catch(() => {
      // Out of range or permission revoked; it stays listed as not heard.
    });
  }
  if (devices.length === 0 && !app.bt.active) app.mode = null;
  requestListRender();
}

function startDemo() {
  heading.startCompass().then(updateCapabilityUi);
  app.bt?.stop();
  registry.clear();
  clearRows();
  app.sim = new SimulatedSource({ getHeading: () => heading.current() ?? heading.heading });
  app.sim.addEventListener('advertisement', handleAdvertisement);
  app.sim.start();
  app.mode = 'demo';
  updateModeUi();
  renderList();
}

function stopDemo() {
  app.sim?.stop();
  app.sim = null;
  registry.clear();
  clearRows();
  app.mode = null;
}

function stopAll() {
  if (app.mode === 'demo') {
    stopDemo();
    restoreRemembered();
  } else if (app.bt) {
    app.bt.stopScan();
    if (!app.bt.active) app.mode = null;
  }
  updateModeUi();
  renderList();
}

// ------------------------------------------------------------- list view

const rows = new Map();
let listTimer = null;

function clearRows() {
  for (const row of rows.values()) row.li.remove();
  rows.clear();
  app.order = [];
}

function requestListRender() {
  if (listTimer || finderVisible()) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    renderList();
  }, 400);
}

function createRow(id) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'device-row';
  button.innerHTML = `
    <span class="bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    <span class="device-main"><span class="device-name"></span><span class="device-meta"></span></span>
    <span class="device-signal"><span class="device-rssi"></span><span class="device-dist"></span></span>`;
  button.addEventListener('click', () => selectDevice(id));
  li.append(button);
  const row = {
    li,
    button,
    bars: button.querySelector('.bars'),
    name: button.querySelector('.device-name'),
    meta: button.querySelector('.device-meta'),
    rssi: button.querySelector('.device-rssi'),
    dist: button.querySelector('.device-dist'),
  };
  rows.set(id, row);
  return row;
}

function updateRow(row, device, now) {
  const fresh = device.lastSeen !== null && now - device.lastSeen < 10000;
  const meta = [];
  if (device.source === 'demo') meta.push('Simulated');
  else if (app.remembered.has(device.id)) meta.push('Remembered');
  if (device.name && device.manufacturer) meta.push(device.manufacturer);
  meta.push(device.lastSeen !== null ? `heard ${ago(now - device.lastSeen)}` : 'not heard yet');

  row.name.textContent = displayName(device);
  row.meta.textContent = meta.join(' · ');
  row.rssi.textContent = device.smoothed !== null ? `${Math.round(device.smoothed)} dBm` : '—';
  row.dist.textContent = device.smoothed !== null ? distanceLabel(distanceFor(device)) : '';
  row.bars.dataset.level = fresh ? String(Math.max(1, Math.ceil(signalQuality(device.smoothed) * 4))) : '0';
  row.button.classList.toggle('stale', !fresh);
  row.button.setAttribute('aria-label', `${displayName(device)}. ${row.rssi.textContent}. ${row.dist.textContent}`);
}

function renderList() {
  const now = performance.now();
  const text = $('filter-text').value.trim().toLowerCase();
  const namedOnly = $('filter-named').checked;
  let devices = registry.list().filter((d) => (!namedOnly || d.name) && (!text || displayName(d).toLowerCase().includes(text)));

  // Re-sort by signal every few seconds only, so rows do not jump under your finger.
  const ids = new Set(devices.map((d) => d.id));
  const sameMembers = app.order.length === ids.size && app.order.every((id) => ids.has(id));
  if (now - app.orderAt > 3000 || !sameMembers) {
    const kept = app.order.filter((id) => ids.has(id));
    const added = devices.map((d) => d.id).filter((id) => !kept.includes(id));
    app.order = now - app.orderAt > 3000 ? devices.map((d) => d.id) : [...kept, ...added];
    if (now - app.orderAt > 3000) app.orderAt = now;
  }
  const rank = new Map(app.order.map((id, i) => [id, i]));
  devices = devices.sort((a, b) => rank.get(a.id) - rank.get(b.id));

  const list = $('device-list');
  devices.forEach((device, i) => {
    const row = rows.get(device.id) ?? createRow(device.id);
    updateRow(row, device, now);
    if (list.children[i] !== row.li) list.insertBefore(row.li, list.children[i] ?? null);
  });
  for (const [id, row] of rows) {
    if (!ids.has(id)) row.li.remove();
  }

  const empty = $('list-empty');
  empty.hidden = devices.length > 0;
  if (registry.devices.size > 0) empty.textContent = 'No devices match the filter.';
  else if (app.mode === 'demo') empty.textContent = 'Starting the demo…';
  else if (app.bt?.scanning) empty.textContent = 'Listening… make sure the device is switched on and nearby.';
  else empty.textContent = NATIVE ? 'Tap Scan nearby devices, or try the demo.' : 'Start a scan, pick a device, or try the demo.';
}

// ------------------------------------------------------------ finder view

async function selectDevice(id, { push = true } = {}) {
  heading.startCompass().then(updateCapabilityUi); // inside the tap, for iOS
  app.selectedId = id;
  app.selectedAt = performance.now();
  estimator.reset();
  app.lastGood = null;
  app.target = null;
  app.shownBearing = null;
  app.autoTurn = null;
  app.headings = [];
  const known = app.remembered.get(id);
  if (known && app.bt && !app.bt.watched.has(id) && !app.bt.scanning) {
    app.bt.watchDevice(known).catch((error) => toast(describeBluetoothError(error), true));
  }
  showFinder(push);
}

function showFinder(push) {
  $('list-view').hidden = true;
  $('finder-view').hidden = false;
  window.scrollTo(0, 0);
  if (push) history.pushState({ view: 'finder' }, '', '#finder');
  updateFacingUi();
  updateCalibrationUi();
  $('demo-controls').hidden = app.mode !== 'demo';
  $('show-truth').checked = app.showTruth;
  updateAutoTurnButton();
  requestWakeLock();
  app.lastInfoAt = 0;
  if (!app.looping) {
    app.looping = true;
    requestAnimationFrame(frame);
  }
}

function showList() {
  $('finder-view').hidden = true;
  $('list-view').hidden = false;
  app.selectedId = null;
  app.autoTurn = null;
  beeper.setLevel(null);
  releaseWakeLock();
  renderList();
}

const TREND_WINDOW_MS = 6000;

function recordHeading(now) {
  const list = app.headings;
  if (list.length === 0 || now - list[list.length - 1].t > 100) list.push({ t: now, heading: heading.heading });
  while (list.length && list[0].t < now - TREND_WINDOW_MS) list.shift();
}

/** True if the user turned more than ~40° recently; the trend is meaningless then. */
function isTurning() {
  const list = app.headings;
  if (list.length < 2) return false;
  const ref = list[list.length - 1].heading;
  return list.some((h) => Math.abs(signedDeltaDeg(ref, h.heading)) > 40);
}

function confidenceWord(uncertainty) {
  if (uncertainty <= 20) return 'high';
  if (uncertainty <= 40) return 'medium';
  return 'low';
}

function frame() {
  if (!finderVisible()) {
    app.looping = false;
    return;
  }
  const now = performance.now();
  stepAutoTurn(now);
  dial.setHeading(heading.heading);
  recordHeading(now);
  if (now - app.lastInfoAt > 200) {
    app.lastInfoAt = now;
    updateFinderInfo(now);
  }
  const target = app.target;
  if (target) {
    app.shownBearing = app.shownBearing === null
      ? target.bearing
      : normalizeDeg(app.shownBearing + 0.15 * signedDeltaDeg(app.shownBearing, target.bearing));
    dial.setEstimate({ bearing: app.shownBearing, uncertainty: target.uncertainty }, { stale: target.stale });
  } else {
    app.shownBearing = null;
    dial.setEstimate(null);
  }
  const truth = app.mode === 'demo' && app.showTruth ? app.sim?.truth(app.selectedId) : null;
  dial.setTruth(truth ? truth.bearing : null);
  requestAnimationFrame(frame);
}

function updateFinderInfo(now) {
  const device = registry.get(app.selectedId);
  if (!device) return;
  const est = estimator.estimate(now);
  dial.setBins(est.bins);

  $('finder-name').textContent = displayName(device);
  const meta = [];
  if (device.source === 'demo') meta.push('Simulated device');
  else if (device.manufacturer) meta.push(device.manufacturer);
  meta.push(device.lastSeen !== null ? `heard ${ago(now - device.lastSeen)}` : 'not heard yet');
  $('finder-meta').textContent = meta.join(' · ');

  // Signal-lost warning.
  const silentFor = now - (device.lastSeen ?? app.selectedAt);
  const alert = $('signal-alert');
  alert.hidden = silentFor < 10000;
  if (!alert.hidden) {
    alert.textContent = `No signal for ${Math.round(silentFor / 1000)} s. The device may be out of range or switched off, or connected to a phone or computer (connected devices often stop advertising).`;
  }

  // Direction text and arrow.
  if (est.status === 'ok') app.lastGood = { bearing: est.bearing, uncertainty: est.uncertainty, t: now };
  const facing = heading.current();
  let main;
  let sub;
  if (device.lastSeen === null) {
    main = 'Waiting for signal…';
    sub = 'Make sure the device is switched on and nearby.';
  } else if (facing === null) {
    main = 'Compass not responding';
    sub = 'Wave the phone in a figure-8 to wake the compass, or set your direction by hand.';
  } else if (est.status === 'ok') {
    main = relativeDirectionText(signedDeltaDeg(facing, est.bearing));
    sub = `${cardinalName(est.bearing)} · ${Math.round(est.bearing)}° ± ${Math.round(est.uncertainty)}° · ${confidenceWord(est.uncertainty)} confidence`;
  } else if (est.status === 'unclear') {
    main = 'No clear direction yet';
    sub = 'Keep turning slowly. If the device is very close or the room has lots of echoes, move a few metres and try again.';
  } else {
    main = 'Turn slowly in a full circle';
    sub = `Hold the phone flat in front of your chest. ${Math.round(est.coverage * 100)}% of the circle done.`;
  }

  if (est.status === 'ok') {
    app.target = { bearing: est.bearing, uncertainty: est.uncertainty, stale: false };
  } else if (app.lastGood && now - app.lastGood.t < 60000) {
    app.target = { bearing: app.lastGood.bearing, uncertainty: app.lastGood.uncertainty, stale: true };
    sub += ` Faded arrow: last estimate, ${ago(now - app.lastGood.t)}.`;
  } else {
    app.target = null;
  }
  $('dir-main').textContent = main;
  $('dir-sub').textContent = sub;

  // Stats.
  const fresh = device.lastSeen !== null && now - device.lastSeen < 5000;
  $('stat-signal').textContent = device.smoothed !== null ? `${Math.round(device.smoothed)} dBm` : '—';
  const calibrated = calibrationFor(device) !== undefined;
  $('stat-distance').textContent = device.smoothed !== null
    ? `${distanceLabel(distanceFor(device))}${calibrated ? ' (calibrated)' : ''}`
    : '—';
  // The trend is for walking: while turning, body shadowing would fake it.
  const turning = isTurning();
  const trend = turning ? null : trendLabel(rssiTrend(device.history, now, TREND_WINDOW_MS));
  const trendNode = $('stat-trend');
  trendNode.textContent = turning ? 'Paused while turning' : ({ warmer: 'Warmer ↑', colder: 'Colder ↓', steady: 'No clear change' }[trend] ?? '—');
  trendNode.className = turning ? 'trend-paused' : trend ? `trend-${trend}` : '';
  $('stat-coverage').textContent = `${Math.round(est.coverage * 100)}%`;
  drawSparkline($('sparkline'), device.history, now);

  beeper.setLevel(app.sound && fresh ? signalQuality(device.smoothed) : null);
}

// -------------------------------------------------- facing / manual input

function updateFacingUi() {
  const manual = heading.mode === 'manual';
  $('facing').hidden = !manual;
  $('btn-manual').hidden = manual;
  $('btn-compass').hidden = !heading.compassAvailable;
  $('facing-help').textContent = heading.compassAvailable
    ? 'Compass paused. Drag the dial, use the slider, or press ← → to set the way you face.'
    : 'No compass found. Drag the dial, use the slider, or press ← → to set the way you face.';
  $('dial').classList.toggle('draggable', manual);
  updateFacingValue();
}

function updateFacingValue() {
  const h = Math.round(heading.heading) % 360;
  $('facing-slider').value = String(h);
  $('facing-value').textContent = `${h}° ${cardinalName(h)}`;
}

function setFacing(value) {
  app.autoTurn = null;
  updateAutoTurnButton();
  heading.setManual(value);
  updateFacingUi();
}

function stepAutoTurn(now) {
  if (!app.autoTurn) return;
  const progress = Math.min(1, (now - app.autoTurn.start) / app.autoTurn.duration);
  heading.setManual(app.autoTurn.from + 360 * progress);
  if (progress >= 1) {
    app.autoTurn = null;
    updateAutoTurnButton();
  }
}

function updateAutoTurnButton() {
  $('btn-autoturn').textContent = app.autoTurn ? 'Stop turning' : 'Turn around for me';
}

function setupDialDrag() {
  const svg = $('dial');
  let drag = null;
  const angleOf = (event) => {
    const box = svg.getBoundingClientRect();
    const dx = event.clientX - (box.left + box.width / 2);
    const dy = event.clientY - (box.top + box.height / 2);
    return normalizeDeg((Math.atan2(dx, -dy) * 180) / Math.PI);
  };
  svg.addEventListener('pointerdown', (event) => {
    if (heading.mode !== 'manual') return;
    drag = { pointer: angleOf(event), heading: heading.heading };
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove', (event) => {
    if (!drag) return;
    // The rose follows the finger, so turning it clockwise means you turned anticlockwise.
    setFacing(drag.heading - signedDeltaDeg(drag.pointer, angleOf(event)));
  });
  const end = () => { drag = null; };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
}

function onKeyDown(event) {
  if (!finderVisible() || event.target.matches('input, textarea')) return;
  const big = event.shiftKey ? 15 : 5;
  if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && heading.mode === 'manual') {
    setFacing(heading.heading + (event.key === 'ArrowLeft' ? -big : big));
    event.preventDefault();
  } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && app.mode === 'demo') {
    app.sim?.step(event.key === 'ArrowUp' ? 1 : -1);
    event.preventDefault();
  }
}

// --------------------------------------------------------- other controls

function updateCalibrationUi() {
  const device = registry.get(app.selectedId);
  const calibrated = device && calibrationFor(device) !== undefined;
  $('btn-calibrate').textContent = calibrated ? 'Recalibrate at 1 m' : 'Calibrate at 1 m';
  $('btn-clear-cal').hidden = !calibrated;
}

function calibrate() {
  const device = registry.get(app.selectedId);
  const recent = device ? device.history.filter((h) => h.t > performance.now() - 5000) : [];
  if (recent.length < 3) {
    toast('Hold the phone 1 m from the device for a few seconds first, so there is a steady signal.', true);
    return;
  }
  const mean = recent.reduce((sum, h) => sum + h.rssi, 0) / recent.length;
  settings.calibration[device.id] = Math.round(mean);
  saveSettings();
  updateCalibrationUi();
  toast(`Calibrated: ${Math.round(mean)} dBm at 1 m.`);
}

function clearCalibration() {
  delete settings.calibration[app.selectedId];
  saveSettings();
  updateCalibrationUi();
}

async function toggleSound() {
  app.sound = !app.sound;
  if (app.sound && !(await beeper.enable())) {
    app.sound = false;
    toast('Sound is not available in this browser.', true);
  }
  if (!app.sound) beeper.disable();
  $('btn-sound').textContent = app.sound ? 'Sound: on' : 'Sound: off';
  $('btn-sound').setAttribute('aria-pressed', String(app.sound));
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !app.wakeLock) {
      app.wakeLock = await navigator.wakeLock.request('screen');
      app.wakeLock.addEventListener('release', () => { app.wakeLock = null; });
    }
  } catch {
    // Not supported or refused; the screen may turn off while searching.
  }
}

function releaseWakeLock() {
  app.wakeLock?.release().catch(() => {});
  app.wakeLock = null;
}

// -------------------------------------------------- capabilities and modes

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function setChip(id, state, text) {
  const chip = $(id);
  chip.className = `chip ${state}`;
  chip.textContent = text;
}

function updateCapabilityUi() {
  const caps = app.caps;
  if (!caps) return;
  const btOk = caps.webBluetooth && caps.adapter !== false;
  if (caps.problem === 'waiting') setChip('chip-bluetooth', 'unknown', 'Bluetooth…');
  else setChip('chip-bluetooth', btOk ? 'ok' : 'bad', btOk ? 'Bluetooth ✓' : caps.native ? 'Bluetooth off' : 'No Bluetooth');
  const signalOk = caps.scan || caps.watch;
  setChip('chip-signal', signalOk ? 'ok' : 'bad', signalOk ? 'Signal strength ✓' : 'No signal strength');
  setChip('chip-compass', heading.compassAvailable ? 'ok' : 'unknown', heading.compassAvailable ? 'Compass ✓' : 'No compass');

  // In the app, Scan stays tappable when Bluetooth is off or not allowed: the
  // tap re-checks and explains what to change (Control Center does not
  // trigger any event the page can see).
  const canScan = caps.native ? caps.problem !== 'unsupported' : btOk && caps.scan;
  $('btn-scan').disabled = !canScan || Boolean(app.bt?.scanning);
  $('btn-pick').disabled = !btOk || !caps.watch;
  $('btn-pick').hidden = Boolean(caps.native); // the app's scan already sees every device
  $('btn-scan').title = caps.scan ? '' : 'Needs the experimental Web Bluetooth scanning API';
  $('btn-pick').title = caps.watch ? '' : 'Needs watchAdvertisements(), an experimental Web Bluetooth API';
}

function renderNotice() {
  const caps = app.caps;
  const notice = $('notice');
  let html = '';
  if (caps.native) {
    if (caps.problem === 'waiting') {
      html = '<strong>Waiting for Bluetooth…</strong> If iOS asks whether BT Finder may use Bluetooth, tap Allow.';
    } else if (caps.problem === 'denied') {
      html = '<strong>Bluetooth access is off for BT Finder.</strong> Turn it on in Settings → Privacy &amp; Security → Bluetooth, then come back.';
    } else if (caps.problem === 'unsupported') {
      html = `<strong>Bluetooth could not be started.</strong> ${escapeHtml(caps.error ?? '')} You can still try the demo.`;
    } else if (caps.adapter === false) {
      html = '<strong>Bluetooth is off.</strong> Turn it on in Control Center, then tap Scan.';
    }
  } else if (!caps.secureContext) {
    html = '<strong>Open this page over HTTPS.</strong> Browsers only allow Bluetooth on secure pages (https:// or localhost).';
  } else if (!caps.webBluetooth) {
    html = '<strong>This browser has no Web Bluetooth.</strong> Use Chrome or Edge on Android, Windows, macOS or ChromeOS. On iPhone no browser can do this; use the BT Finder iPhone app instead (see the project README). You can still try the demo.';
  } else if (caps.adapter === false) {
    html = '<strong>Bluetooth seems to be off.</strong> Turn on Bluetooth (and on Android, Location) and reload the page.';
  } else if (!caps.scan || !caps.watch) {
    html = `<strong>One more step:</strong> reading signal strength is still an experimental browser feature.
      Open <code>${FLAG_URL}</code> in the address bar, set it to <em>Enabled</em>, and restart the browser.
      <button id="btn-copy-flag" class="link" type="button">Copy address</button>`;
  }
  notice.innerHTML = html;
  notice.hidden = html === '';
  $('btn-copy-flag')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(FLAG_URL);
      toast('Copied. Paste it into the address bar.');
    } catch {
      toast(`Could not copy. Type ${FLAG_URL} into the address bar.`, true);
    }
  });
}

function updateModeUi() {
  updateCapabilityUi();
  const banner = $('mode-banner');
  const scanning = Boolean(app.bt?.scanning);
  const watching = app.bt ? app.bt.watched.size : 0;
  let text = '';
  if (app.mode === 'demo') text = 'Demo mode: these devices are simulated. Pick one to try finding it.';
  else if (scanning) text = 'Scanning for nearby Bluetooth devices…';
  else if (watching > 0) text = `Following ${watching} device${watching === 1 ? '' : 's'} you picked.`;
  banner.textContent = text;
  banner.hidden = text === '';
  $('btn-stop').hidden = !(app.mode === 'demo' || scanning);
  $('btn-stop').textContent = app.mode === 'demo' ? 'Exit demo' : 'Stop scanning';
  $('btn-demo').hidden = app.mode === 'demo';
  $('btn-scan').textContent = scanning ? 'Scanning…' : 'Scan nearby devices';
}

// --------------------------------------------------------------- wiring

function wireEvents() {
  $('btn-scan').addEventListener('click', startScan);
  $('btn-pick').addEventListener('click', pickDevice);
  $('btn-demo').addEventListener('click', startDemo);
  $('btn-stop').addEventListener('click', stopAll);
  $('btn-back').addEventListener('click', () => {
    if (history.state?.view === 'finder') history.back();
    else showList();
  });
  window.addEventListener('popstate', () => {
    if (finderVisible()) showList();
  });

  $('filter-text').addEventListener('input', renderList);
  $('filter-named').checked = settings.namedOnly;
  $('filter-named').addEventListener('change', () => {
    settings.namedOnly = $('filter-named').checked;
    saveSettings();
    renderList();
  });

  $('btn-reset').addEventListener('click', () => {
    estimator.reset();
    app.lastGood = null;
    toast('Sweep restarted. Turn slowly in a full circle.');
  });
  $('btn-calibrate').addEventListener('click', calibrate);
  $('btn-clear-cal').addEventListener('click', clearCalibration);
  $('btn-sound').addEventListener('click', toggleSound);

  $('facing-slider').addEventListener('input', () => setFacing(Number($('facing-slider').value)));
  $('btn-manual').addEventListener('click', () => setFacing(heading.heading));
  $('btn-compass').addEventListener('click', () => {
    app.autoTurn = null;
    updateAutoTurnButton();
    heading.useCompass();
    updateFacingUi();
  });
  heading.addEventListener('change', () => {
    if (heading.mode === 'manual') updateFacingValue();
  });
  heading.addEventListener('compass', () => {
    updateCapabilityUi();
    if (finderVisible()) updateFacingUi();
  });
  setupDialDrag();
  document.addEventListener('keydown', onKeyDown);

  $('btn-autoturn').addEventListener('click', () => {
    if (app.autoTurn) {
      app.autoTurn = null;
    } else {
      heading.setManual(heading.heading);
      updateFacingUi();
      app.autoTurn = { start: performance.now(), from: heading.heading, duration: 15000 };
    }
    updateAutoTurnButton();
  });
  $('btn-step').addEventListener('click', () => app.sim?.step(1));
  $('btn-step-back').addEventListener('click', () => app.sim?.step(-1));
  $('show-truth').addEventListener('change', () => { app.showTruth = $('show-truth').checked; });

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && finderVisible()) requestWakeLock();
    if (document.visibilityState === 'visible' && NATIVE) await refreshNativeCapabilities();
    updateModeUi();
  });
  navigator.bluetooth?.addEventListener?.('availabilitychanged', (event) => {
    app.caps.adapter = event.value;
    renderNotice();
    updateCapabilityUi();
  });
}

async function init() {
  if (location.hash === '#finder') history.replaceState(null, '', location.pathname + location.search);
  // Buttons first, so the app responds even if a Bluetooth check is slow.
  wireEvents();
  renderList();
  // Works without a tap on Android; iOS asks again on the first button press.
  heading.startCompass().then(updateCapabilityUi);
  if (NATIVE) {
    await refreshNativeCapabilities();
  } else {
    app.caps = await detectCapabilities();
    renderNotice();
  }
  if (new URLSearchParams(location.search).has('demo')) startDemo();
  else await restoreRemembered();
  updateModeUi();
  renderList();
  setInterval(() => {
    if (!finderVisible()) renderList();
  }, 1000);
}

// Show unexpected errors instead of failing silently (they also reach the
// Xcode console in the iPhone app).
function reportError(error) {
  console.error(error);
  toast(`Something went wrong: ${error?.message ?? error}`, true);
}
window.addEventListener('error', (event) => reportError(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => reportError(event.reason));

init().catch(reportError);
