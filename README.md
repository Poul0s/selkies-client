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
cp config.example.json ~/.config/selkies-client/config.json   # then edit it
make start            # run in dev mode
```

Without a config file you can still connect with
`--host=IP:PORT [--user=NAME]` and the password from the `SELKIES_PASSWORD` environment variable.

## Configuration

The config file is read from, in order:

1. `--config=/path/to/config.json`
2. the `SELKIES_CLIENT_CONFIG` environment variable
3. `<userData>/config.json` — `~/.config/selkies-client/` on Linux, `%APPDATA%\selkies-client\` on Windows

See [`config.example.json`](config.example.json). Top-level keys are global
defaults; each entry in `profiles` overrides them.

| Key | Description | Default |
| --- | --- | --- |
| `default` | Profile used when `--profile` is not given | first profile |
| `shortcuts.toggleCapture` | Capture / release the keyboard | `Ctrl+Alt+Shift+Z` |
| `shortcuts.reload` | Reload the page (ignoring cache) | `Ctrl+Alt+Shift+R` |
| `shortcuts.quit` | Quit the app | `Ctrl+Alt+Shift+Q` |
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

### Self-signed certificates

Start the client once: if the certificate is untrusted, a dialog shows its
fingerprint. Copy it into `certFingerprint` of the profile and relaunch.

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
src/main.js      window, keyboard capture, shortcuts, hooks, TLS/auth/permissions
src/config.js    config loading, profiles, CLI arguments, password lookup
build/icon.png   application icon
Makefile         install / start / build / sign
```
