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

/** For tests: use a fake plugin instead of Capacitor's. */
export function setPluginForTesting(plugin) {
  ble = plugin;
  loadPromise = Promise.resolve();
  readyPromise = Promise.resolve();
}

// iOS only lists connected devices that offer one of the services you name,
// so ask for the common standard ones plus Garmin's own. Devices that only
// use Classic Bluetooth are never listed.
export const CONNECTED_SERVICES = [
  '1800', // Generic Access (every device has it, but iOS may not match on it)
  '180a', // Device Information
  '180f', // Battery
  '180d', // Heart Rate
  '1812', // Human Interface Device: keyboards, mice, remotes
  '1814', // Running Speed and Cadence
  '1816', // Cycling Speed and Cadence
  '1818', // Cycling Power
  '1826', // Fitness Machine
  'fe1f', // Garmin
  '6a4e2401-667b-11e3-949a-0800200c9a66', // Garmin watches (GFDI)
  '6a4e2500-667b-11e3-949a-0800200c9a66', // Garmin watches
  '6a4e2800-667b-11e3-949a-0800200c9a66', // Garmin watches (multi-link)
];

/**
 * Bluetooth LE devices that are connected to this iPhone (by any app, e.g.
 * Garmin Connect), as [{ id, name }]. Connected devices often stop
 * advertising, so a scan does not see them.
 */
export async function connectedDevices() {
  await ready();
  const result = await ble.getConnectedDevices({ services: CONNECTED_SERVICES });
  return (result?.devices ?? [])
    .filter((device) => device?.deviceId)
    .map((device) => ({ id: device.deviceId, name: device.name ?? '' }));
}

/** Convert an RSSI reading of a connected device (the plugin sends a string) into an advertisement. */
export function fromRssiReading(id, value, t) {
  return {
    id,
    name: '',
    rssi: Number(value),
    txPower: null,
    manufacturerIds: [],
    uuids: [],
    t,
    source: 'connected',
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  /**
   * `rssiIntervalMs`: pause between signal readings of a connected device.
   * `retryMs`: wait before reconnecting after a connected device was lost.
   */
  constructor({ rssiIntervalMs = 100, retryMs = 2000 } = {}) {
    super();
    // Connected devices being followed: id -> { stopped, connected, error }.
    // Advertising devices need no following: scanning sees them all.
    this.watched = new Map();
    this.isScanning = false;
    this.listener = null;
    this.rssiIntervalMs = rssiIntervalMs;
    this.retryMs = retryMs;
  }

  get active() {
    return this.isScanning || this.watched.size > 0;
  }

  /**
   * Follow a device that is connected to the iPhone: connect to it from this
   * app too (the existing connection is shared, other apps are not affected)
   * and read its signal strength several times a second. The readings arrive
   * as "advertisement" events like scan results.
   */
  follow(id) {
    if (this.watched.has(id)) return;
    const entry = { stopped: false, connected: false, error: null };
    this.watched.set(id, entry);
    this.#followLoop(id, entry);
  }

  /** Stop following a connected device and drop this app's connection to it. */
  unfollow(id) {
    const entry = this.watched.get(id);
    if (!entry) return;
    entry.stopped = true;
    this.watched.delete(id);
    if (entry.connected) ble.disconnect({ deviceId: id }).catch(() => {});
  }

  /** Last error while following `id`, or null. */
  followError(id) {
    return this.watched.get(id)?.error ?? null;
  }

  async #followLoop(id, entry) {
    while (!entry.stopped) {
      try {
        if (!entry.connected) {
          await ready();
          // Service discovery is part of connecting; descriptors are not needed.
          await ble.connect({ deviceId: id, timeout: 10000, skipDescriptorDiscovery: true });
          entry.connected = true;
          if (entry.stopped) {
            ble.disconnect({ deviceId: id }).catch(() => {});
            return;
          }
        }
        const { value } = await ble.readRssi({ deviceId: id });
        if (entry.stopped) return;
        entry.error = null;
        const ad = fromRssiReading(id, value, performance.now());
        this.dispatchEvent(new CustomEvent('advertisement', { detail: ad }));
        await sleep(this.rssiIntervalMs);
      } catch (error) {
        // Out of range, switched off or disconnected: try again in a moment.
        entry.connected = false;
        entry.error = error?.message ?? String(error);
        if (entry.stopped) return;
        await sleep(this.retryMs);
      }
    }
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
    for (const id of [...this.watched.keys()]) this.unfollow(id);
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
