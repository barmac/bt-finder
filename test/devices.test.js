import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceRegistry, displayName } from '../web/js/devices.js';
import { manufacturerName } from '../web/js/manufacturers.js';

const ad = (overrides) => ({ id: 'a', name: '', rssi: -60, txPower: null, manufacturerIds: [], uuids: [], t: 0, source: 'scan', ...overrides });

test('ingest builds one record per device and keeps the latest name', () => {
  const registry = new DeviceRegistry();
  registry.ingest(ad({ t: 0 }));
  registry.ingest(ad({ name: 'Headphones', t: 100 }));
  registry.ingest(ad({ t: 200 }));
  const device = registry.get('a');
  assert.equal(registry.devices.size, 1);
  assert.equal(device.name, 'Headphones');
  assert.equal(device.count, 3);
  assert.equal(device.lastSeen, 200);
});

test('invalid RSSI updates metadata but not the signal', () => {
  const registry = new DeviceRegistry();
  const device = registry.ingest(ad({ rssi: 127, name: 'Tag' }));
  assert.equal(device.name, 'Tag');
  assert.equal(device.smoothed, null);
  assert.equal(device.lastSeen, null);
});

test('list is sorted strongest first, unheard devices last', () => {
  const registry = new DeviceRegistry();
  registry.touch({ id: 'quiet' });
  registry.ingest(ad({ id: 'far', rssi: -90 }));
  registry.ingest(ad({ id: 'near', rssi: -50 }));
  assert.deepEqual(registry.list().map((d) => d.id), ['near', 'far', 'quiet']);
});

test('history keeps only the recent window', () => {
  const registry = new DeviceRegistry({ historyMs: 1000 });
  for (let t = 0; t <= 3000; t += 250) registry.ingest(ad({ t }));
  const { history } = registry.get('a');
  assert.ok(history[0].t >= 2000);
  assert.equal(history[history.length - 1].t, 3000);
});

test('display names fall back to the manufacturer', () => {
  const registry = new DeviceRegistry();
  const apple = registry.ingest(ad({ id: 'x', manufacturerIds: [0x004c] }));
  assert.equal(displayName(apple), 'Apple device');
  const unknown = registry.ingest(ad({ id: 'y', manufacturerIds: [0xffff] }));
  assert.equal(displayName(unknown), 'Unnamed device');
  assert.equal(manufacturerName([0xffff, 0x0075]), 'Samsung');
});
