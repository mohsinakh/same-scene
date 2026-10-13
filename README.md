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

1. Start a movie night and send the permanent guest invite. Your browser remembers the room; **Open your watch room** reopens it next time.
2. Choose a movie file that Firefox can decode. H.264/AAC in MP4 is a good starting point. Container names alone do not guarantee codec support.
3. Play, pause, or seek using the native player. The app draws live frames to a canvas and sends video plus a Web Audio track using WebRTC. The movie file is not uploaded to hosting or signaling.
4. Keep the host's tab visible. Browser background throttling, sleep, and a locked device can interrupt the live stream.

Movie audio is taken directly from the player, avoiding Firefox's lack of `getDisplayMedia` audio capture. Local playback uses a separate Web Audio gain so the app's movie volume slider changes only what the host hears. Native player volume/mute controls may also affect the captured source; use the app volume slider for independent listening volume.

### Screen/window sharing + BlackHole

Firefox captures the picture but does not provide system/tab audio via `getDisplayMedia`. This is a browser limitation; static hosting or a Worker cannot fix it.

For a movie playing on a site in Firefox:

1. Install [BlackHole 2ch](https://existential.audio/blackhole/). Only the host needs it.
2. Create a Multi-Output Device in Audio MIDI Setup containing BlackHole and your headphones, with the physical output as clock source and drift correction enabled for BlackHole. [Official guide](https://github.com/ExistentialAudio/BlackHole/wiki/Multi-Output-Device).
3. Start a room, then **Choose headphones** under Call audio output. Select the physical headphones explicitly, not System default, BlackHole or the Multi-Output Device. This uses Firefox's `selectAudioOutput()` and media-element `setSinkId()` to route received call audio away from BlackHole. The app saves this choice and restores it when Firefox still grants access. If permission has expired, click **Choose headphones** once to approve the saved device again.
4. Select the Multi-Output Device as macOS sound output. The movie's normal sound now goes to headphones and BlackHole. The guest's voice goes only to the explicitly selected physical call output.
5. In the app click **Find devices**, grant audio-input access, select BlackHole for movie audio and a physical microphone for voice. Keep **Listen to captured audio too** off because you already hear the movie.
6. Share the movie window. Allow Firefox screen recording if macOS requests it. Keep the movie and app tabs open. Restore your normal macOS output after the session.

Other system audio may also reach BlackHole in this setup, so keep unrelated apps quiet. If headphones disconnect, stop sharing and reconnect/reselect the physical call output before continuing. Do not send the call to System default while the default output includes BlackHole: this creates feedback. If output selection is unsupported, use current Firefox or app-specific routing instead.

For VLC, you can instead select BlackHole as VLC's audio output while keeping macOS output on headphones. Choose the physical call output in the app and enable **Listen to captured audio too** to hear the captured movie locally. Do not enable this monitor when a Multi-Output Device already plays the same movie into your headphones; you would hear it twice.

Protected streaming services can block capture. This app does not bypass DRM. Live screen sharing adds delay, and the host's local playback is ahead of the received video.

## Saved host audio defaults

The host's device selectors, physical call output, monitor toggle, noise processing, movie/voice volume, and outgoing movie boost are saved locally. Use **Save host defaults** after choosing your inputs and headphones; later user changes also save automatically. Reopening a host room applies these preferences without turning mic or camera on. Saved device IDs are matched first, then labels, if browser permission exposes the device. A missing or unapproved output requires explicit selection again; the app does not pretend it is restored.

Movie audio is sent through a separate gain stage (200% by default, adjustable from 100% to 400%) and a limiter. This boost affects the guest's soundtrack, not their voice or the host's own movie playback. A live outgoing-audio meter reports whether the captured soundtrack contains a signal. Boost cannot create sound if BlackHole receives silence. Mac system output must still route the movie to the mirrored Multi-Output Device; a website cannot set macOS's system output.

## Reusable room links

Guest invites and host links have no built-in expiry. Closing or leaving ends captures without deleting the room credentials. The home page remembers the latest successfully joined host room and guest seat independently in `localStorage`; following a guest invite does not replace your saved host room. **Copy my host link** provides a portable backup for bookmarks or another browser. Browser storage can be cleared or blocked, so keep the links if you want to retain the room independently of this browser. Credentials remain in URL fragments and local browser storage; no room database is needed.

**Create a different room** replaces the remembered host room with a new one after connecting, but existing links remain usable. It does not revoke access to the old room. The host must return and start sharing for the guest to see a movie. Capture permissions and audio routing are set up again each session. Connections still depend on the hosted signaling service being available.

## Guest on Android or Windows

Open the full invite in Chrome and tap **Join movie night**. Permissions are requested only when turning on mic/camera. If autoplay is blocked, tap **Enable sound**. Keep Chrome foregrounded and the device unlocked. Android guests do not need screen-capture support because they only receive the movie. Headphones reduce microphone echo.

The corner-rectangle fullscreen button expands the whole movie player, including movie volume, mute, voice volume and the exit button. Controls and the title hide after three seconds without pointer, touch or keyboard activity; moving the pointer or tapping the movie brings them back. Keyboard users keep controls visible while focused on them. With the player focused, **F** toggles fullscreen, **M** toggles movie mute and **↑/↓** adjust movie volume. Double-click the received movie to toggle fullscreen. On touch devices the app requests landscape orientation after entering fullscreen and releases the lock on exit. If the browser declines the lock, fullscreen continues with a rotate-phone hint; actual device support varies.

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
