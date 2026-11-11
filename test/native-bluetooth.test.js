import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromScanResult, isNativeApp } from '../web/js/native-bluetooth.js';

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
