// Copies Capacitor's JavaScript runtime into web/vendor/ so the app, which has
// no bundler, can import it inside the iPhone app. Run by `npm run ios:sync`.
// The file is git-ignored and is not needed by the website.
import { copyFile, mkdir } from 'node:fs/promises';

const source = new URL('../node_modules/@capacitor/core/dist/index.js', import.meta.url);
const targetDir = new URL('../web/vendor/', import.meta.url);

await mkdir(targetDir, { recursive: true });
await copyFile(source, new URL('capacitor-core.js', targetDir));
console.log('Copied @capacitor/core to web/vendor/capacitor-core.js');
