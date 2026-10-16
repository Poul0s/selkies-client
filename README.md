# Selkies Client

A minimal fullscreen Electron client for [Selkies](https://github.com/selkies-project/selkies-gstreamer).
It opens a Selkies web UI in a locked-down window and captures the keyboard
(Keyboard Lock API) so that system shortcuts (Alt+Tab, Super, …) go to the remote
session instead of the local desktop.

- Linux (AppImage) and Windows (portable `.exe`) builds, **no root / admin rights needed**
- Multiple server profiles, credentials kept out of the config file if you want
- Hooks run when the keyboard is captured/released (e.g. switch your window manager to a passthrough mode)
- Hardened window: sandboxed renderer, navigation limited to the server origin, permission allow-list, certificate pinning

## Quick start

```sh
make install          # npm dependencies
make start            # run in dev mode
```

The app opens a launcher (Moonlight-style grid of computers). Click **Add** to
create a profile, click a tile to connect, use the ✎ button to edit it, and
**⚙ Settings** for defaults shared by all profiles. Everything is saved to the
config file described below, so editing it by hand still works.

Each profile has its own host, credentials, certificate pin, **bitrate limit**
(Mbps or kbps), **quality** preset, input options, shortcuts and hooks. In a
profile, “Override” unchecked means the global value is used.

While streaming: `Ctrl+Alt+Shift+Q` closes the session (back to the launcher, same as the
window's ✕), `Ctrl+Alt+Shift+Z` toggles keyboard capture. Closing the launcher quits the app.
Letter shortcuts follow your keyboard layout (AZERTY and QWERTY both work).

Capturing the keyboard asks the Selkies client for its own *gaming mode* (fullscreen,
pointer lock and keyboard lock), the same thing as the dashboard's gaming-mode button,
which is what lets Chromium hold the Win key. The client shortcuts are detected both
by Electron and from inside the page, so they keep working while the keyboard is locked.

Passing `--profile=NAME` or `--host=IP:PORT [--user=NAME]` skips the launcher and
connects directly (the password comes from `SELKIES_PASSWORD` if not in the profile).

## Window-manager hooks (Linux)

The launcher detects i3, Sway, Hyprland and GNOME (from `I3SOCK`, `SWAYSOCK`,
`HYPRLAND_INSTANCE_SIGNATURE`, `XDG_CURRENT_DESKTOP`) and proposes the matching
`onCapture` / `onRelease` hooks, which switch the WM to a shortcut-free mode
while the keyboard is captured so that Super-key combos reach the remote machine.

- New configuration: the hooks are filled in automatically.
- GNOME has no passthrough mode, so the hooks unbind every Super, Alt+Tab and Ctrl+Alt shortcut
  (window manager, shell, media keys, dock) with `gsettings` on capture and reset them on release (they are also reset on quit).
- **⚙ Settings → Detect hooks** re-detects the desktop and refills the hook fields on demand
  (click Save to keep them).
- Existing configuration with different hooks: a banner asks **Yes** (replace),
  **No** (ask again next time) or **Don't ask again** (`"autoHooks": false`).

The mode itself must exist in your WM config, e.g. for i3/Sway `mode "passthrough" {}`
(Hyprland: a `passthrough` submap).

## Configuration

The config file is read from, in order:

1. `--config=/path/to/config.json`
2. the `SELKIES_CLIENT_CONFIG` environment variable
3. `<userData>/config.json` — `~/.config/selkies-client/` on Linux, `%APPDATA%\selkies-client\` on Windows

The launcher edits this file for you; you can also edit it by hand. Top-level keys are global
defaults; each entry in `profiles` overrides them.

| Key | Description | Default |
| --- | --- | --- |
| `default` | Profile used when `--profile` is not given | first profile |
| `shortcuts.toggleCapture` | Capture / release the keyboard | `Ctrl+Alt+Shift+Z` |
| `shortcuts.reload` | Reload the page (ignoring cache) | `Ctrl+Alt+Shift+R` |
| `shortcuts.disconnect` | Close the session, back to the launcher (the old `quit` key is migrated to this one) | `Ctrl+Alt+Shift+Q` |
| `stream.bitrateKbps` | Bitrate limit in kbps, `0` = no limit | `0` |
| `stream.bitrateUnit` | Unit shown in the launcher (`Mbps` / `kbps`) | `Mbps` |
| `stream.quality` | `auto`, `low`, `balanced`, `high`, `ultra` | `auto` |
| `autoCapture` | Capture the keyboard once the page has loaded | `true` |
| `recaptureOnFocus` | Re-capture when the window regains focus | `false` |
| `hooks.onCapture` / `hooks.onRelease` | List of commands (argv arrays, no shell) | `[]` |
| `permissions` | Web permissions granted to the server origin | fullscreen, keyboardLock, clipboard, pointerLock, media |
| `insecure` | Accept any TLS certificate for the server (not recommended) | `false` |

Profile keys:

| Key | Description |
| --- | --- |
| `host` | `host:port` or a full `http(s)://` URL (HTTPS assumed otherwise) |
| `user` | Basic-auth user (default `user`) |
| `passwordFile` | File containing the password (`~` expanded; `chmod 600` recommended) |
| `passwordEnv` | Name of the environment variable holding the password (default `SELKIES_PASSWORD`) |
| `password` | Plain-text password (discouraged) |
| `certFingerprint` | Pinned certificate fingerprint for self-signed servers |
| `hooks`, `shortcuts`, … | Any global key can be overridden per profile |

Password lookup order: `--password` → environment variable → `passwordFile` → `password`.

### Stream settings

The Selkies web client keeps its settings in `localStorage`; before the page
loads, the app writes these values there (`src/preload-stream.js`):

- with a bitrate limit: `rate_control_mode=cbr` and `video_bitrate=<kbps>`;
- quality preset (constant-quality mode, used when there is no bitrate limit,
  plus JPEG quality): low = CRF 38 / JPEG 30, balanced = 28 / 50, high = 23 / 75, ultra = 18 / 90;
- `auto` leaves the client's own (or the server's) settings untouched.

The server can still lock or clamp these values (`--video-bitrate`, `--video-crf`, … in Selkies).

### Self-signed certificates

On first connection to a server with an untrusted certificate, a dialog shows
its fingerprint; choosing **Trust and save** stores it as `certFingerprint` in
the profile. (When started with `--host`, copy it into the profile by hand.)

### Command line

```
--profile=NAME   --host=HOST[:PORT]   --user=NAME   --config=PATH   --password=...
```

### Hooks example

```json
"hooks": {
  "onCapture": [["i3-msg", "mode", "passthrough"]],
  "onRelease": [["i3-msg", "mode", "default"]]
}
```

`onRelease` is also run when the app quits while captured. Hooks are
platform specific: the `i3-msg` example is Linux-only, use `[]` on Windows.

## Building

Everything goes through the `Makefile` (run `make help`):

| Command | Result |
| --- | --- |
| `make build` | Linux AppImage + Windows portable exe |
| `make build-linux` | `dist/Selkies Client-<version>-linux.AppImage` |
| `make build-win` | `dist/Selkies Client-<version>-win.exe` (signed) |
| `make cert` | Regenerate the self-signed code-signing certificate in `certs/` |
| `make clean` / `make distclean` | Remove `dist/` / also `node_modules/`, `certs/`, `tools/` |

Notes:

- Both targets are built from Linux. The AppImage can be run with
  `chmod +x` (add `--appimage-extract-and-run` if FUSE is unavailable).
- **Signing**: `make build-win` creates a self-signed certificate (`certs/`,
  password `selkies`, override with `CERT_PASS=…`) and signs the exe with
  `osslsigncode`. The one bundled with electron-builder needs libcrypto 1.1,
  so the Makefile extracts the distribution package (`apt-get download`, no root)
  into `tools/`. A self-signed signature is **not trusted** by Windows:
  SmartScreen will still warn. To fix that, buy a certificate from a trusted CA and run
  `WIN_CSC_LINK=cert.pfx WIN_CSC_KEY_PASSWORD=… npm run dist:win`.
- Never commit `certs/`.
- Icon: `build/icon.png` (512×512).

## Project layout

```
src/main.js            launcher + stream windows, keyboard capture, hooks, TLS/auth/permissions
src/config.js          config read/write, profiles, CLI arguments, stream settings
src/preload-stream.js  seeds bitrate/quality into the Selkies page's localStorage
src/ui/                launcher (index.html, app.js, style.css, preload.js)
build/icon.png   application icon
Makefile         install / start / build / sign
```
