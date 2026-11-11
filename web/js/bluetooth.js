// Thin wrappers around the Web Bluetooth API.
//
// Signal strength is only exposed through advertisements:
//  - navigator.bluetooth.requestLEScan()      lists every nearby device
//  - BluetoothDevice.watchAdvertisements()    follows one device you picked
// Both are behind chrome://flags/#enable-experimental-web-platform-features
// at the time of writing, so everything here is feature-detected.

/** What this browser can do. */
export async function detectCapabilities() {
  const bt = typeof navigator !== 'undefined' ? navigator.bluetooth : undefined;
  const caps = {
    secureContext: typeof window !== 'undefined' && window.isSecureContext,
    webBluetooth: Boolean(bt),
    scan: Boolean(bt) && typeof bt.requestLEScan === 'function',
    watch: typeof BluetoothDevice !== 'undefined' && 'watchAdvertisements' in BluetoothDevice.prototype,
    getDevices: Boolean(bt) && typeof bt.getDevices === 'function',
    adapter: null,
  };
  if (bt && typeof bt.getAvailability === 'function') {
    try {
      caps.adapter = await bt.getAvailability();
    } catch {
      caps.adapter = null;
    }
  }
  return caps;
}

function toAdvertisement(event, source) {
  const device = event.device;
  return {
    id: device.id,
    name: event.name || device.name || '',
    rssi: event.rssi,
    txPower: event.txPower ?? null,
    manufacturerIds: event.manufacturerData ? [...event.manufacturerData.keys()] : [],
    uuids: event.uuids ? [...event.uuids] : [],
    t: performance.now(),
    source,
  };
}

/**
 * Receives advertisements from real Bluetooth hardware. Events fired at a
 * watched device also bubble to navigator.bluetooth, so each event object is
 * only reported once.
 */
export class BluetoothSource extends EventTarget {
  constructor() {
    super();
    this.scan = null;
    this.watched = new Map();
    this.seen = new WeakSet();
    this.onAdvertisement = (event) => {
      if (this.seen.has(event)) return;
      this.seen.add(event);
      const source = this.scan?.active ? 'scan' : 'watch';
      this.dispatchEvent(new CustomEvent('advertisement', { detail: toAdvertisement(event, source) }));
    };
    this.listening = false;
  }

  #listen() {
    if (this.listening) return;
    navigator.bluetooth.addEventListener('advertisementreceived', this.onAdvertisement);
    this.listening = true;
  }

  get active() {
    return Boolean(this.scan?.active) || this.watched.size > 0;
  }

  get scanning() {
    return Boolean(this.scan?.active);
  }

  /** Scan for every advertising device nearby. Must be called from a user gesture. */
  async startScan() {
    this.#listen();
    if (this.scan?.active) return;
    this.scan = await navigator.bluetooth.requestLEScan({
      acceptAllAdvertisements: true,
      keepRepeatedDevices: true,
    });
  }

  stopScan() {
    if (this.scan?.active) this.scan.stop();
    this.scan = null;
  }

  /** Let the user pick one device in the browser's chooser, then follow it. */
  async pickDevice() {
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true });
    await this.watchDevice(device);
    return device;
  }

  /** Follow advertisements of a device this site already has permission for. */
  async watchDevice(device) {
    if (this.watched.has(device.id)) return;
    this.#listen();
    if (typeof device.watchAdvertisements !== 'function') {
      throw new Error('This browser cannot read the signal strength of a single device (watchAdvertisements is missing).');
    }
    const controller = new AbortController();
    device.addEventListener('advertisementreceived', this.onAdvertisement);
    try {
      await device.watchAdvertisements({ signal: controller.signal });
    } catch (error) {
      device.removeEventListener('advertisementreceived', this.onAdvertisement);
      throw error;
    }
    this.watched.set(device.id, { device, controller });
    this.dispatchEvent(new CustomEvent('device', { detail: { id: device.id, name: device.name || '', source: 'watch' } }));
  }

  /** Devices this site was given permission to earlier (needs getDevices()). */
  async rememberedDevices() {
    if (typeof navigator.bluetooth?.getDevices !== 'function') return [];
    try {
      return await navigator.bluetooth.getDevices();
    } catch {
      return [];
    }
  }

  stop() {
    this.stopScan();
    for (const { device, controller } of this.watched.values()) {
      controller.abort();
      device.removeEventListener('advertisementreceived', this.onAdvertisement);
    }
    this.watched.clear();
    if (this.listening) {
      navigator.bluetooth.removeEventListener('advertisementreceived', this.onAdvertisement);
      this.listening = false;
    }
  }
}

/** Friendlier text for errors thrown by Web Bluetooth calls. */
export function describeBluetoothError(error) {
  const name = error?.name;
  if (name === 'NotFoundError') return 'No device was chosen.';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Bluetooth permission was denied. Allow Bluetooth (and on Android, Location / Nearby devices) for this browser and try again.';
  }
  if (name === 'NotSupportedError') return 'This browser does not support that Bluetooth feature.';
  if (name === 'InvalidStateError') return 'Bluetooth is busy or turned off. Make sure Bluetooth is on.';
  return error?.message || String(error);
}
