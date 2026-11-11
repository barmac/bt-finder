import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTED_SERVICES,
  NativeBluetoothSource,
  connectedDevices,
  fromRssiReading,
  fromScanResult,
  isNativeApp,
  setPluginForTesting,
} from '../web/js/native-bluetooth.js';

async function waitFor(condition, ms = 1000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Stand-in for the Capacitor plugin. The second RSSI read fails, as when a device drops out. */
function fakePlugin({ connectFails = false } = {}) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    count: (name) => calls.filter((call) => call[0] === name).length,
    async getConnectedDevices(options) {
      calls.push(['getConnectedDevices', options]);
      return { devices: [{ deviceId: 'W1', name: 'Forerunner 255' }, { deviceId: 'K2' }, {}] };
    },
    async connect({ deviceId }) {
      calls.push(['connect', deviceId]);
      if (connectFails) throw new Error('Connection timeout.');
    },
    async readRssi({ deviceId }) {
      calls.push(['readRssi', deviceId]);
      reads += 1;
      if (reads === 2) throw new Error('Not connected to device.');
      return { value: String(-60 - reads) };
    },
    async disconnect({ deviceId }) {
      calls.push(['disconnect', deviceId]);
    },
  };
}

test('plugin scan results become app advertisements', () => {
  const ad = fromScanResult({
    device: { deviceId: 'A1B2', name: 'Cached name' },
    localName: 'Advertised name',
    rssi: -63,
    txPower: -8,
    manufacturerData: { 76: '02 15 ', 89: '' },
    uuids: ['0000feaa-0000-1000-8000-00805f9b34fb'],
  }, 1234);
  assert.deepEqual(ad, {
    id: 'A1B2',
    name: 'Advertised name',
    rssi: -63,
    txPower: -8,
    manufacturerIds: [76, 89],
    uuids: ['0000feaa-0000-1000-8000-00805f9b34fb'],
    t: 1234,
    source: 'scan',
  });
});

test('iOS "no TX power" (127) and missing fields are handled', () => {
  const ad = fromScanResult({ device: { deviceId: 'X' }, rssi: -80, txPower: 127 }, 0);
  assert.equal(ad.txPower, null);
  assert.equal(ad.name, '');
  assert.deepEqual(ad.manufacturerIds, []);
  assert.deepEqual(ad.uuids, []);
  assert.equal(fromScanResult({ device: { deviceId: 'Y', name: 'Tag' }, rssi: -70 }, 0).name, 'Tag');
});

test('outside the app, native mode is off', () => {
  assert.equal(isNativeApp(), false);
});

test('RSSI readings of connected devices become advertisements', () => {
  assert.deepEqual(fromRssiReading('W1', '-58', 42), {
    id: 'W1',
    name: '',
    rssi: -58,
    txPower: null,
    manufacturerIds: [],
    uuids: [],
    t: 42,
    source: 'connected',
  });
});

test('connected-device services are valid UUIDs (an invalid one crashes CoreBluetooth)', () => {
  for (const uuid of CONNECTED_SERVICES) {
    assert.match(uuid, /^([0-9a-f]{4}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
  }
});

test('connected devices are listed with the services to look for', async () => {
  const plugin = fakePlugin();
  setPluginForTesting(plugin);
  assert.deepEqual(await connectedDevices(), [{ id: 'W1', name: 'Forerunner 255' }, { id: 'K2', name: '' }]);
  assert.deepEqual(plugin.calls[0], ['getConnectedDevices', { services: CONNECTED_SERVICES }]);
});

test('following a connected device reads its signal and reconnects after losing it', async () => {
  const plugin = fakePlugin();
  setPluginForTesting(plugin);
  const source = new NativeBluetoothSource({ rssiIntervalMs: 1, retryMs: 1 });
  const readings = [];
  source.addEventListener('advertisement', (event) => readings.push(event.detail));

  source.follow('W1');
  source.follow('W1'); // following twice does not start a second loop
  assert.equal(source.active, true);
  await waitFor(() => readings.length >= 3);
  source.unfollow('W1');

  assert.deepEqual(readings.slice(0, 3).map((ad) => ad.rssi), [-61, -63, -64]);
  assert.ok(readings.every((ad) => ad.id === 'W1' && ad.source === 'connected'));
  assert.equal(plugin.count('connect'), 2, 'reconnects once after the failed read');
  assert.equal(plugin.count('disconnect'), 1);
  assert.equal(source.active, false);

  const reads = plugin.count('readRssi');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(plugin.count('readRssi'), reads, 'no reads after unfollow');
});

test('a device that cannot be reached reports why and keeps retrying', async () => {
  const plugin = fakePlugin({ connectFails: true });
  setPluginForTesting(plugin);
  const source = new NativeBluetoothSource({ rssiIntervalMs: 1, retryMs: 1 });
  source.follow('W1');
  await waitFor(() => plugin.count('connect') >= 2);
  assert.equal(source.followError('W1'), 'Connection timeout.');
  source.stop();
  assert.equal(source.followError('W1'), null);
  assert.equal(plugin.count('disconnect'), 0, 'nothing to disconnect');
});
