# BT Finder

A web app that finds nearby Bluetooth devices and shows the approximate direction to the one you pick, like a compass needle that points at your lost earbuds.

- Lists nearby Bluetooth Low Energy devices with signal strength and a rough distance
- Points an arrow toward the selected device, with an uncertainty wedge
- Shows a warmer/colder trend, a 30-second signal graph, and optional Geiger-counter beeps
- Includes a demo mode with simulated devices, so you can try it on any browser

No build step and no dependencies: plain HTML, CSS and JavaScript modules in [`web/`](web/).

## How the direction is estimated

Bluetooth radios in phones report signal strength (RSSI), not direction. BT Finder uses your body instead:
2.4 GHz radio waves are strongly absorbed by the human body (typically 10–20 dB), so if you hold the
phone in front of your chest and turn around slowly, the signal is strongest when you face the device
and weakest when it is behind you.

While you turn, the app records `(compass heading, RSSI)` pairs, averages them into 15° bins and fits
`rssi(θ) = c + a·cos θ + b·sin θ` by weighted least squares ([`direction.js`](web/js/direction.js)).
The peak of that curve is the estimated bearing, and the fit's covariance gives the ± uncertainty shown
on the dial. On simulated data the median error is about 5°, and the reported ±2σ range contains the
true bearing 95% of the time. Real rooms are messier because of reflections, so expect ±20–45° indoors.
Repeat the sweep every few metres as you walk.

Distance uses the log-distance path-loss model and is only a rough guide. Calibrating at 1 m for a
specific device makes it better.

## Requirements

| What | Why |
| --- | --- |
| **Chrome or Edge**: Android (best), Windows, macOS, ChromeOS | Web Bluetooth is not available in Firefox or Safari. On iPhone, the [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) browser supports it. |
| **The flag** `chrome://flags/#enable-experimental-web-platform-features` set to *Enabled* | Reading signal strength (`requestLEScan()` and `watchAdvertisements()`) is still experimental in Chrome. |
| **HTTPS** (or `localhost`) | Browsers only allow Bluetooth on secure pages. |
| **A phone with a compass** | To know which way you are facing. Without one, you can set your direction by hand. |
| On Android: Bluetooth **and** Location on | Android requires Location to scan for Bluetooth devices. |

The app checks all of this itself and tells you what is missing.

## Using it

1. Open the app and tap **Scan nearby devices**. You can also **Pick a device…** from the browser's chooser.
2. Tap the device you are looking for.
3. Hold the phone flat in front of your chest and **turn slowly on the spot**, a full circle in about 15 seconds.
   The ring around the dial fills in as you turn.
4. Follow the arrow a few metres, then turn around again. Use **Trend** (warmer/colder) and **Distance** to tell when you are close.
   Turn on **Sound** to search without looking at the screen.

### Limitations

- Only **Bluetooth Low Energy** devices that are **advertising** can be found. Classic-only Bluetooth devices
  (older headsets, car kits) are invisible to web pages.
- Many devices **stop advertising while connected** to a phone or computer. To find them, disconnect them
  first, for example by turning Bluetooth off on the phone they are paired with.
- Phones, AirPods and many trackers change their Bluetooth address every few minutes for privacy, so they
  may appear as a new entry after a while.
- Metal, walls and reflections distort signal strength. If the result says *No clear direction*, move a
  few metres and sweep again.

## Run it locally

```sh
npm start          # serves web/ at http://localhost:8080 (demo: http://localhost:8080/?demo)
npm test           # unit tests (Node 20+, no dependencies)
```

To try it on an Android phone during development, either deploy it (below) or use Chrome's
[remote debugging port forwarding](https://developer.chrome.com/docs/devtools/remote-debugging/local-server)
so the phone can open `http://localhost:8080`. A plain `http://192.168.x.x` address will not work,
because Bluetooth needs a secure page.

## Deploy to GitHub Pages

The workflow in [`.github/workflows/pages.yml`](.github/workflows/pages.yml) runs the tests and publishes
the `web/` folder whenever `main` is updated. You can also run it manually from the Actions tab. One-time setup:
**Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Project layout

```
web/
  index.html, styles.css, manifest.webmanifest, icon.svg
  js/app.js               UI and wiring
  js/bluetooth.js         Web Bluetooth scanning / watching, capability checks
  js/heading.js           compass heading from device orientation, or manual
  js/orientation-math.js  heading from alpha/beta/gamma (flat, tilted or upright phone)
  js/direction.js         bearing estimate from heading + RSSI samples
  js/signal.js            Kalman smoothing, distance, warmer/colder trend
  js/devices.js           per-device records and history
  js/simulator.js         demo world with simulated devices
  js/dial.js, beeper.js   compass dial rendering, sound feedback
test/                     node:test unit tests
scripts/serve.mjs         tiny static server for development
```
