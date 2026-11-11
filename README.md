# BT Finder

A web app that finds nearby Bluetooth devices and shows the approximate direction to the one you pick, like a compass needle that points at your lost earbuds.

- Lists nearby Bluetooth Low Energy devices with signal strength and a rough distance
- Points an arrow toward the selected device, with an uncertainty wedge
- Shows a warmer/colder trend, a 30-second signal graph, and optional Geiger-counter beeps
- Includes a demo mode with simulated devices, so you can try it on any browser
- Runs as a website (Chrome on Android and desktop) and as an [iPhone app](#iphone-app)

The app is plain HTML, CSS and JavaScript modules in [`web/`](web/), with no build step. The iPhone
app wraps the same code with [Capacitor](https://capacitorjs.com/).

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
| **Chrome or Edge**: Android (best), Windows, macOS, ChromeOS | Web Bluetooth is not available in Firefox or Safari. On iPhone, use the [iPhone app](#iphone-app). |
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
  first, for example by turning Bluetooth off on the phone they are paired with. The iPhone app can also
  find Bluetooth LE devices that are connected to that iPhone, such as a watch
  (see [Connected devices](#connected-devices)).
- Phones, AirPods and many trackers change their Bluetooth address every few minutes for privacy, so they
  may appear as a new entry after a while.
- Metal, walls and reflections distort signal strength. If the result says *No clear direction*, move a
  few metres and sweep again.

## iPhone app

Safari (and every other iPhone browser) has no Web Bluetooth, so on iPhone the same app runs inside a
native shell made with Capacitor. Bluetooth goes through Apple's CoreBluetooth via the
[`@capacitor-community/bluetooth-le`](https://github.com/capacitor-community/bluetooth-le) plugin
([`native-bluetooth.js`](web/js/native-bluetooth.js)). Everything else is the same code as the website.

**You need:** a Mac with **Xcode 26 or later** and **Node 22 or later**, an iPhone with its cable, and an
Apple ID (a free one works).

```sh
git clone https://github.com/barmac/bt-finder.git
cd bt-finder
npm install
npm run ios:sync     # copies web/ into the Xcode project
npm run ios:open     # opens Xcode
```

In Xcode:

1. **Xcode → Settings → Accounts**: add your Apple ID.
2. In the left sidebar select **App**, then the **App** target → **Signing & Capabilities** →
   **Team**: pick your Apple ID ("Personal Team"). If Xcode says the bundle identifier is not available,
   change `io.github.barmac.btfinder` to something unique of your own.
3. Plug in the iPhone, unlock it and tap **Trust**. On the iPhone, turn on
   **Settings → Privacy & Security → Developer Mode** (it restarts the phone).
4. Choose your iPhone as the run destination at the top of the Xcode window and press **▶ Run**.
   The first build downloads the Capacitor packages and takes a few minutes.
5. With a free Apple ID, the first launch is blocked as an "Untrusted Developer": on the iPhone go to
   **Settings → General → VPN & Device Management**, tap your Apple ID and **Trust**, then open the app.
6. Allow Bluetooth when the app asks.

After changing anything in `web/`, run `npm run ios:sync` and press Run again. With a free Apple ID the
app stops opening after 7 days; reconnect the phone and press Run to reinstall it. A paid Apple Developer
Program membership makes installs last a year and allows TestFlight.

In the app, **Scan nearby devices** sees every advertising device directly, so there is no
*Pick a device* button and no browser flag to turn on.

### Connected devices

A watch or fitness tracker that is connected to the iPhone (for example through Garmin Connect) usually
stops advertising, so a scan cannot see it. The app lists such devices anyway; tick **Connected to iPhone**
to show only those. When you pick one, BT Finder connects to it too and reads its signal strength over
that connection several times a second. The connection is shared, so the device's own app keeps working.
iOS only lists Bluetooth LE devices that offer one of the services the app asks for (common standard ones
and Garmin's), and never devices that use only Classic Bluetooth.

## Run it locally

```sh
npm start          # serves web/ at http://localhost:8080 (demo: http://localhost:8080/?demo)
npm test           # unit tests (no npm install needed)
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
  js/native-bluetooth.js  the same for the iPhone app (CoreBluetooth via Capacitor)
  js/heading.js           compass heading from device orientation, or manual
  js/orientation-math.js  heading from alpha/beta/gamma (flat, tilted or upright phone)
  js/direction.js         bearing estimate from heading + RSSI samples
  js/signal.js            Kalman smoothing, distance, warmer/colder trend
  js/devices.js           per-device records and history
  js/simulator.js         demo world with simulated devices
  js/dial.js, beeper.js   compass dial rendering, sound feedback
ios/                      Xcode project for the iPhone app (Capacitor)
capacitor.config.json     app id and name for the iPhone app
test/                     node:test unit tests
scripts/serve.mjs         tiny static server for development
scripts/vendor-capacitor.mjs  copies Capacitor's runtime into web/vendor/ for the app
```
