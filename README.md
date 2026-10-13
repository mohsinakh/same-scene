# Same Scene

A desktop-hosted movie night for two. The host uses Firefox on macOS; their guest can watch and optionally use microphone/camera in Chrome on Windows or Android. Only the host shares movie video. Microphone, camera, and movie are independent streams with separate incoming movie and voice volume.

## Run locally

Requires Node.js 22 or later. There are no npm dependencies to install.

```sh
npm run check
npm run dev
```

Open http://127.0.0.1:4173. Camera/mic capture needs HTTPS or localhost. A localhost invite on your Mac is not reachable from another person's device; deploy the app to share remote invites.

## Firefox on macOS: two movie sources

### Local movie file (simplest)

1. Start a movie night and send the guest invite.
2. Choose a movie file that Firefox can decode. H.264/AAC in MP4 is a good starting point. Container names alone do not guarantee codec support.
3. Play, pause, or seek using the native player. The app draws live frames to a canvas and sends video plus a Web Audio track using WebRTC. The movie file is not uploaded to hosting or signaling.
4. Keep the host's tab visible. Browser background throttling, sleep, and a locked device can interrupt the live stream.

Movie audio is taken directly from the player, avoiding Firefox's lack of `getDisplayMedia` audio capture. Local playback uses a separate Web Audio gain so the app's movie volume slider changes only what the host hears. Native player volume/mute controls may also affect the captured source; use the app volume slider for independent listening volume.

### Screen/window sharing + BlackHole

Firefox captures the picture but does not provide system/tab audio via `getDisplayMedia`. This is a browser limitation; static hosting or a Worker cannot fix it.

1. Install [BlackHole 2ch](https://existential.audio/blackhole/).
2. In VLC Preferences → Audio, choose BlackHole as the movie player's output. Keep macOS system output on headphones. The app monitors the selected movie input so you can hear it too.
3. In the app, click **Find devices**, allow microphone-device access, and choose **BlackHole 2ch** under movie audio. Choose your physical microphone under your microphone.
4. Share the movie window. macOS may require Firefox screen-recording permission and a browser restart.
5. If using a Multi-Output Device for local movie listening, select it in the movie player only. Set the app movie volume to zero to avoid hearing both the player and the app monitor.

**Do not route all macOS output into BlackHole while using the call.** That includes the guest's received voice and produces a feedback loop. Capturing movie sound from another Firefox tab needs app-specific routing, such as OBS application audio capture into BlackHole. The local-file option avoids this complexity.

Protected streaming services can block capture. This app does not bypass DRM. Live screen sharing adds delay, and the host's local playback is ahead of the received video.

## Guest on Android or Windows

Open the full invite in Chrome and tap **Join movie night**. Permissions are requested only when turning on mic/camera. If autoplay is blocked, tap **Enable sound**. Keep Chrome foregrounded and the device unlocked. Android guests do not need screen-capture support because they only receive the movie. Headphones reduce microphone echo.

## Hosting for free

`npm run build` emits a standalone `dist/` folder with relative paths, suitable for a GitHub Pages repository subpath or Cloudflare static assets.

### GitHub Pages

Use a new public repository for a GitHub Free account. Push this source to `main`, then Settings → Pages → Source → GitHub Actions. The included workflow checks, builds and deploys `dist/` on each push. The app source and hosted landing page will be public; rooms use randomly generated private invite credentials, separate from the public site.

### Cloudflare Workers (static assets)

The included `wrangler.jsonc` only serves the built static app. It does not proxy movie traffic or act as a media relay.

```sh
npm run build
npx wrangler login
npx wrangler deploy
```

Alternatively deploy `dist/` to Cloudflare Pages. No D1, R2, paid media service, or custom Worker signaling backend is required.

## Connection & privacy

- VDO.Ninja SDK 1.6.2 is vendored under MPL-2.0 with its license. It provides hosted signaling and auto-fetches TURN service configuration. Media/data use WebRTC; TURN relays encrypted transport when a direct connection fails. Third-party service availability and limits apply.
- Room identifier and random 192-bit key are in the URL fragment, which browsers do not send to static hosting in HTTP requests. The key is supplied to the SDK for password-based signaling protection. The SDK and browser still contact their network services. Direct WebRTC peers may learn each other's IP addresses.
- Mic and camera begin off. No movie storage, chat history, analytics or recording features are implemented. Fonts load from Google Fonts; fallback fonts work offline.
- Anyone possessing the full invite has room access. This first version assumes a trusted host/guest pair: role selection is a client UI affordance, not server-enforced identity, admission or authorization. Do not reuse one guest link for a group; multiple guests use the same stream identifiers and can collide. Create another room to rotate credentials.
- Media capture ends on Leave or page exit. The SDK attempts recovery on temporary network loss; leaving and reopening the same link also recreates the connection.

## Phase 2

Groups are not implemented in this version. Future work requires unique participant stream identifiers, admission/role enforcement, participant tiles and bandwidth testing. Mesh streaming makes host upload grow with viewer count. Larger groups need a forwarding service or synchronized local playback.

## Verification limits

Automated checks cover invite validation, fragment-only credentials, role-based subscriptions and SDK discovery event formats. Browser integration tests passed on macOS with a Firefox 153 host and Chromium guest, as well as two Chromium peers: both-direction synthetic microphone and camera, local movie frames and decoded audible soundtrack, independent volumes, mic off/on during movie playback, stopping/replacing movies, camera off, leave cleanup and a 390px phone layout. No uncaught page errors occurred. These tests use synthetic devices and a generated WebM file, not your personal media or webcam.

Actual macOS permission prompts, BlackHole routing, Windows Chrome and physical Android Chrome remain to be verified on your devices. A phone-sized desktop test cannot certify Android behavior. Screen sharing and local playback can differ under background throttling and real network conditions.

To rerun the optional browser integration suite, install Playwright and its browsers, start `npm run dev`, and run `node tests/browser.mjs`. Set `TEST_FIREFOX=1` for Firefox-host/Chromium-guest testing; default is Chromium at both ends. A local Playwright module can be selected with `PLAYWRIGHT_PATH`, and a Chromium executable with `CHROMIUM_PATH`.
