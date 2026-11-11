// A few common Bluetooth SIG company identifiers, used to label devices that
// do not advertise a name. Full list: bluetooth.com/specifications/assigned-numbers
const COMPANIES = new Map([
  [0x0002, 'Intel'],
  [0x0006, 'Microsoft'],
  [0x000d, 'Texas Instruments'],
  [0x000f, 'Broadcom'],
  [0x004c, 'Apple'],
  [0x0059, 'Nordic Semiconductor'],
  [0x0075, 'Samsung'],
  [0x0087, 'Garmin'],
  [0x009e, 'Bose'],
  [0x00e0, 'Google'],
  [0x012d, 'Sony'],
  [0x0499, 'Ruuvi'],
]);

/** Company name for the first known identifier, or null. */
export function manufacturerName(companyIds = []) {
  for (const id of companyIds) {
    const name = COMPANIES.get(id);
    if (name) return name;
  }
  return null;
}
