// Bluetooth for the iPhone app.
//
// Inside the Capacitor app there is no Web Bluetooth; the
// @capacitor-community/bluetooth-le plugin scans with CoreBluetooth instead.
// NativeBluetoothSource has the same interface as BluetoothSource in
// bluetooth.js, so the rest of the app does not care which one it uses.

/** True when running inside the native (Capacitor) app. */
export function isNativeApp() {
  return typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true;
}

// The Capacitor plugin object. IMPORTANT: never resolve a promise with it or
// return it from an async function. It is a Proxy that answers to every
// property name, including "then", so promises treat it as a thenable and
// wait on it forever. Keep it in this variable and resolve promises to nothing.
let ble = null;
let loadPromise = null;
let readyPromise = null;

/** Load Capacitor's runtime and the plugin into `ble`. Resolves to undefined. */
function loadPlugin() {
  // web/vendor/capacitor-core.js is copied from @capacitor/core by
  // `npm run ios:sync` (scripts/vendor-capacitor.mjs); it only exists in the app.
  loadPromise ??= import('../vendor/capacitor-core.js').then(({ registerPlugin }) => {
    ble = registerPlugin('BluetoothLe');
  });
  return loadPromise;
}

/**
 * Start CoreBluetooth once; afterwards `ble` is usable. iOS asks for
 * Bluetooth permission the first time. Resolves to undefined.
 */
function ready() {
  readyPromise ??= loadPlugin()
    .then(() => ble.initialize())
    .then(() => undefined)
    .catch((error) => {
      readyPromise = null;
      throw error;
    });
  return readyPromise;
}

/** Resolves once CoreBluetooth has started (after the user answers the permission prompt). */
export function nativeBluetoothReady() {
  return ready();
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`No answer from Bluetooth after ${ms} ms`);
      error.name = 'TimeoutError';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function nativeError(message) {
  const error = new Error(message);
  error.name = 'NativeBluetoothError';
  return error;
}

/**
 * Convert a plugin scan result into the app's advertisement format.
 * iOS reports a TX power of 127 when the device does not advertise one.
 */
export function fromScanResult(result, t) {
  const tx = result.txPower;
  return {
    id: result.device?.deviceId ?? null,
    name: result.localName || result.device?.name || '',
    rssi: result.rssi,
    txPower: Number.isFinite(tx) && tx !== 127 ? tx : null,
    manufacturerIds: Object.keys(result.manufacturerData ?? {}).map(Number).filter(Number.isInteger),
    uuids: result.uuids ?? [],
    t,
    source: 'scan',
  };
}

/**
 * Capabilities in the same shape as detectCapabilities() in bluetooth.js.
 * Never waits more than `timeoutMs`: CoreBluetooth only answers once iOS has
 * reported its state, which waits for the user on the permission prompt.
 * `problem` is null, "waiting", "denied" or "unsupported" (see `error`).
 */
export async function detectNativeCapabilities({ timeoutMs = 4000 } = {}) {
  const caps = {
    native: true,
    secureContext: true,
    webBluetooth: true,
    scan: true,
    watch: false,
    getDevices: false,
    adapter: null,
    problem: null,
    error: null,
  };
  try {
    await withTimeout(ready(), timeoutMs);
    caps.adapter = (await withTimeout(ble.isEnabled(), timeoutMs)).value;
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      caps.problem = 'waiting';
    } else {
      console.error('Bluetooth could not start:', error);
      caps.adapter = false;
      caps.error = error?.message ?? String(error);
      caps.problem = /denied|unauthori/i.test(caps.error) ? 'denied' : 'unsupported';
    }
  }
  return caps;
}

export class NativeBluetoothSource extends EventTarget {
  constructor() {
    super();
    this.watched = new Map(); // single-device watching is not needed: scanning sees everything
    this.isScanning = false;
    this.listener = null;
  }

  get active() {
    return this.isScanning;
  }

  get scanning() {
    return this.isScanning;
  }

  async startScan() {
    if (this.isScanning) return;
    try {
      await ready();
    } catch (error) {
      if (/denied|unauthori/i.test(error?.message ?? '')) {
        throw nativeError('BT Finder is not allowed to use Bluetooth. Turn it on in Settings → Privacy & Security → Bluetooth.');
      }
      throw nativeError(`Bluetooth is not available: ${error?.message ?? error}`);
    }
    if (!(await ble.isEnabled()).value) {
      throw nativeError('Bluetooth is turned off. Turn it on in Control Center, then try again.');
    }
    this.listener ??= await ble.addListener('onScanResult', (result) => {
      const ad = fromScanResult(result, performance.now());
      if (ad.id) this.dispatchEvent(new CustomEvent('advertisement', { detail: ad }));
    });
    // allowDuplicates: report every advertisement, not just the first per device,
    // so the signal strength keeps updating.
    try {
      await ble.requestLEScan({ allowDuplicates: true });
    } catch (error) {
      // If a scan was still running (e.g. after the page reloaded), the plugin
      // stops it and refuses; starting again then works.
      if (!/already scanning/i.test(error?.message ?? '')) throw error;
      await ble.requestLEScan({ allowDuplicates: true });
    }
    this.isScanning = true;
  }

  stopScan() {
    if (!this.isScanning) return;
    this.isScanning = false;
    loadPlugin().then(() => ble.stopLEScan()).catch(() => {});
  }

  stop() {
    this.stopScan();
    this.listener?.remove();
    this.listener = null;
  }

  async pickDevice() {
    throw nativeError('Picking a single device is not needed in the app: scanning finds every nearby device.');
  }

  async watchDevice() {
    throw nativeError('Not supported in the app.');
  }

  async rememberedDevices() {
    return [];
  }
}
