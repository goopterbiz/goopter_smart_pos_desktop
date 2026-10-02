# Goopter Smart POS for desktop

An Electron app for macOS, Windows and Linux that hosts the Odoo POS at
`https://<store>.goopter.com` in a kiosk window and lets the page print to printers on the store
LAN. It is the desktop counterpart of `goopter_smart_pos_ios` and `goopter_smart_pos_android`.

The design of record is `goopter_smart_pos_ios/SPEC.md`. Section references below point into it.

## The bridge

The page gets `window.GoopterPOS`, with the same shape and behaviour as on iOS and Android (§3):

```js
if (window.GoopterPOS?.protocolVersions?.includes(2)) {
    const result = await window.GoopterPOS.print({
        protocol_version: 2,
        printer: { host: "10.0.0.50", port: 9100 },
        data_base64: "G0AbYQE..."
    });
    // { successful: true, bytes: 12480 }
    // { successful: false, message: "..." }  <- shown verbatim to the cashier
}
```

`window.goopterPrinter` (Bluetooth) is not provided. A page that feature-detects it treats this app
as TCP only.

The same rules as the other two apps hold:

- The bridge exists only in the main frame of an `https` page on `goopter.com` or a subdomain of it.
  The main process re-checks the calling frame's origin on every call.
- Destinations are RFC1918 or link-local IPv4 literals on ports 9100 to 9109, 515 or 631 (§8.1).
- One job per printer, 4 in flight, 5 s connect, 12 s for the whole job (§9).
- Payload bytes are never logged (§11).

## Layout

| Path | Contents | Tested by |
|---|---|---|
| `src/bridge/` | Envelope, destination policy, printer gate, deadline, socket transport, job log, store name, host and navigation policy. Imports nothing from Electron. | `npm test` |
| `src/main/` | Kiosk window, IPC, navigation handling, store persistence | `npm run test:e2e` |
| `src/preload/preload.ts` | Exposes `GoopterPOS` or the shell API, as the main process decides per frame | `npm run test:e2e` |
| `renderer/` | Store entry, load failure and diagnostic log screens | `npm run test:e2e` |

`src/bridge/` mirrors the Android `:bridge` module type for type and test for test. A fix in one
should be checked against the others.

## Commands

```sh
npm install
npm test                 # logic tests, including real loopback sockets
npm run typecheck
npm run test:e2e         # builds, then drives a real Electron window
npm start                # build and run
npm run dist             # unsigned installers into release/
```

`npm run dist` builds for the current platform. Pass `-- --mac`, `-- --win` or `-- --linux` to
choose. Code signing, notarization and auto-update are not configured.

### Development against a local Odoo

These variables are honoured only in an unpackaged build (`npm start`). A packaged build ignores
them.

| Variable | Effect |
|---|---|
| `GOOPTER_DEBUG_URL=http://localhost:8069/odoo/point-of-sale` | Load this instead of the saved store. Its origin gets the bridge. |
| `GOOPTER_WINDOWED=true` | Ordinary window with developer tools instead of kiosk, whatever window mode is saved. |
| `GOOPTER_USER_DATA=/tmp/x` | Keep settings, log and cookies in another directory. |

## At the till

| Shortcut | Action |
|---|---|
| Ctrl+Shift+L (Cmd+Shift+L on macOS) | Diagnostic log. Its ⋯ menu has Home, Change store and Window mode |
| Ctrl+Shift+Q (Cmd+Shift+Q on macOS) | Quit, after a confirmation |

The store is asked for once and remembered. Change store clears the saved store and the website
data, so the next store does not open signed in as the last one.

Window mode is Kiosk or Window. It applies at once and is saved as `{"kiosk": false}` or
`{"kiosk": true}` in `settings.json` in the user data folder, so it holds on every launch. A missing
or unreadable file means kiosk. In an unpackaged build `GOOPTER_WINDOWED=true` overrides it. Window
mode never enables developer tools.

The display is kept awake while the POS is open.

## Differences from the iOS and Android apps

| | Why |
|---|---|
| No Bluetooth | Out of scope for this app. |
| No background assertion (§10) | Desktop apps are not suspended. |
| No iPad layout fix (§6.5) or fit-to-window zoom (§6.4) | Odoo serves Chromium its desktop layout. |
| Log opens with a shortcut, not a four-finger press | No touch screen is assumed. |
| `tel:`, `mailto:` and `sms:` links are dropped | Electron does not report whether a person clicked, and the rule is to hand these to the system only on a click. |
| Nothing opens in the system browser | A kiosk has no tabs, and a till should not leave the POS. New-window requests are refused, so Odoo's kiosk launcher falls back to loading the kiosk in the app window. Navigation outside `goopter.com` is cancelled. |
| `window.prompt()` returns nothing | Electron does not implement it. `alert` and `confirm` work. |
| The macOS permission message (§8.2) is always a guess | macOS 15+ asks before the app may reach the LAN and offers no API to read the answer. After failures to several distinct printers in a row, the message points at System Settings > Privacy & Security > Local Network. Windows and Linux have no such permission and always show the plain message. |
| The macOS Local Network prompt is requested at startup | On macOS 15+ the app connects a UDP socket to a multicast address before opening the POS (TN3179's documented trigger, no data sent), so the prompt is answered at launch rather than during the first print. Windows, Linux and macOS before 15 do nothing here. |

## Not verified

Nothing has printed to a real printer. The macOS Local Network prompt has not been seen, and the
§8.2 heuristic has not met a real denial. The §14 device checklist applies here too: print a receipt
from each platform before relying on it.

The startup prompt (C3) is unverified for the same reason: TN3179 tracks the permission by code
signature, and it cannot be reset once granted or denied, so only an Apple-signed build run in a
fresh macOS user account can show whether the prompt now appears at launch instead of at the first
print.
