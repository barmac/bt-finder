import { RssiKalman, isValidRssi } from './signal.js';
import { manufacturerName } from './manufacturers.js';

/**
 * Keeps one record per Bluetooth device seen, with raw and smoothed RSSI and
 * a short history for trends and sparklines.
 *
 * Advertisements are plain objects:
 *   { id, name, rssi, txPower, manufacturerIds, uuids, t, source }
 */
export class DeviceRegistry {
  constructor({ historyMs = 30000 } = {}) {
    this.historyMs = historyMs;
    this.devices = new Map();
  }

  clear() {
    this.devices.clear();
  }

  get(id) {
    return this.devices.get(id) ?? null;
  }

  /** Make sure a device is listed even before it has been heard. */
  touch({ id, name = '', source = 'unknown' }) {
    let device = this.devices.get(id);
    if (!device) {
      device = {
        id,
        name,
        source,
        manufacturer: null,
        txPower: null,
        rssi: null,
        smoothed: null,
        kalman: new RssiKalman(),
        history: [],
        count: 0,
        firstSeen: null,
        lastSeen: null,
      };
      this.devices.set(id, device);
    } else if (name && !device.name) {
      device.name = name;
    }
    return device;
  }

  /** Add an advertisement. Returns the device record, or null if unusable. */
  ingest(ad) {
    if (!ad || !ad.id) return null;
    const device = this.touch(ad);
    if (ad.name) device.name = ad.name;
    if (Number.isFinite(ad.txPower)) device.txPower = ad.txPower;
    const maker = manufacturerName(ad.manufacturerIds);
    if (maker) device.manufacturer = maker;
    if (!isValidRssi(ad.rssi)) return device;

    device.rssi = ad.rssi;
    device.smoothed = device.kalman.update(ad.rssi, ad.t);
    device.count += 1;
    device.firstSeen ??= ad.t;
    device.lastSeen = ad.t;
    device.history.push({ t: ad.t, rssi: ad.rssi, smoothed: device.smoothed });
    const cutoff = ad.t - this.historyMs;
    while (device.history.length && device.history[0].t < cutoff) device.history.shift();
    return device;
  }

  /** Devices sorted strongest first; devices never heard go last. */
  list() {
    return [...this.devices.values()].sort((a, b) => (b.smoothed ?? -999) - (a.smoothed ?? -999));
  }
}

/** Display name for a device record. */
export function displayName(device) {
  if (device.name) return device.name;
  if (device.manufacturer) return `${device.manufacturer} device`;
  return 'Unnamed device';
}
