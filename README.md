# Selkies Client

A minimal fullscreen Electron client for [Selkies](https://github.com/selkies-project/selkies-gstreamer).
It opens a Selkies web UI in a locked-down window and captures the keyboard
(Keyboard Lock API) so that system shortcuts (Alt+Tab, Super, …) go to the remote
session instead of the local desktop.

- Linux (AppImage) and Windows (portable `.exe`) builds, **no root / admin rights needed**
- Multiple server profiles, credentials kept out of the config file if you want
- Hooks run when the keyboard is captured/released (e.g. switch your window manager to a passthrough mode)
- Hardened window: sandboxed renderer, navigation limited to the server origin, permission allow-list, certificate pinning
- Optional embedded **Tailscale** (no install, no admin rights) for the profiles that ask for it, see [Tailscale](#tailscale-optional)

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
| `stream.mode` | Transport the server runs Selkies in: `auto`, `websocket`, `webrtc` (see [Tailscale](#tailscale-optional)) | `auto` |
| `autoCapture` | Capture the keyboard once the page has loaded | `true` |
| `recaptureOnFocus` | Re-capture when the window regains focus | `false` |
| `hooks.onCapture` / `hooks.onRelease` | List of commands (argv arrays, no shell) | `[]` |
| `permissions` | Web permissions granted to the server origin | fullscreen, keyboardLock, clipboard, pointerLock, media |
| `insecure` | Accept any TLS certificate for the server (not recommended) | `false` |
| `tailscale.enabled` | Turn the embedded Tailscale on (global only) | `false` |
| `tailscale.hostname` | Node name in the tailnet (global only) | `selkies-client-<hostname>` |
| `tailscale.authKeyEnv` / `authKeyFile` / `authKey` | Auth key source, in this order of priority (global only; none = interactive login) | `TS_AUTHKEY` |
| `tailscale.useByDefault` | Profiles go through Tailscale unless they say otherwise | `false` |

Profile keys:

| Key | Description |
| --- | --- |
| `host` | `host:port` or a full `http(s)://` URL (HTTPS assumed otherwise) |
| `user` | Basic-auth user (default `user`) |
| `passwordFile` | File containing the password (`~` expanded; `chmod 600` recommended) |
| `passwordEnv` | Name of the environment variable holding the password (default `SELKIES_PASSWORD`) |
| `password` | Plain-text password (discouraged) |
| `certFingerprint` | Pinned certificate fingerprint for self-signed servers |
| `tailscale.use` | `true`: this profile goes through Tailscale, `false`: it never does. Absent: `tailscale.useByDefault` |
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

## Tailscale (optional)

The app embeds a Tailscale node ([`tsnet`](https://pkg.go.dev/tailscale.com/tsnet), in the Go sidecar of `sidecar/`)
that exposes a SOCKS5 proxy on `127.0.0.1`. Nothing is installed, no root / admin rights are needed, and
without any Tailscale configuration the app behaves exactly as before: no extra process, no proxy.

**Setup**

1. `make sidecar` (needs Go; builds `sidecar/bin/{linux,windows}-amd64/`, also done by `make build`). If the
   binary is missing the Tailscale section says so and nothing else is affected.
2. **⚙ Settings → Tailscale**: tick *Enable Tailscale*, pick the device name and the authentication, click **Connect**.
   The state (disconnected / starting / waiting for login / connected + tailnet IP) is shown live.
   You only do this once: the login is kept in `<userData>/tsnet`, *Disconnect* keeps it,
   *Forget this device* logs the node out of the tailnet and deletes it.
3. In a profile, **Tailscale → Go through Tailscale (SOCKS5)**. It follows the usual *Override* rule:
   unchecked = the global *Default* (`tailscale.useByDefault`), checked = the profile's own value, so a profile can
   also opt out when the default is on. The checkbox only exists once Tailscale is enabled in the Settings.
   Tiles of such profiles carry a *Tailscale* badge.

**Authentication** (global, like the password: the secret does not have to live in the config file)

- *Interactive login*: the login link is opened in your browser the first time (also reachable with *Open login page*).
- *Auth key*, from an environment variable (`TS_AUTHKEY` by default), from a file (`authKeyFile`, one line, `chmod 600`),
  or saved in the config file (`authKey`, discouraged). `TS_AUTHKEY`, when set, wins. The key is handed to the sidecar
  through its environment, never on the command line. Use a reusable or ephemeral key; it is only needed to register the node.

**How a profile goes through Tailscale**

- The sidecar starts **on demand**: when you click *Connect* in the Settings, or open a profile that uses Tailscale.
  It stops with the app (or *Disconnect*). A crash is reported with the sidecar's last messages.
- Only the stream window of such a profile is proxied: it has its own session partition (`persist:tailscale`) with
  `socks5://127.0.0.1:<port>`. Direct profiles and the launcher stay on Electron's default session, untouched.
- If Tailscale is not connected when the profile is opened (not logged in, waiting for approval, sidecar missing or
  crashed), you get a message and the window does **not** open. The app never falls back to a direct connection,
  and a session whose tunnel is lost ends with a message.
- Leaks are shut: WebRTC may not use non-proxied UDP (`disable_non_proxied_udp`), and, when Tailscale is enabled at
  startup, QUIC is disabled and the default session no longer downloads spell-checker dictionaries (Electron fetches
  them from Google as soon as a session exists, which is a direct connection; the Tailscale session never does).
- The proxy is closed by default. It refuses everything except: `CONNECT` to the profile's own `host:port`, which must also
  be a Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48) or a tailnet peer name resolved by the tailnet itself
  (never by the system DNS). Nothing is reachable while no Tailscale session is open.

**Stream mode**

The SOCKS5 proxy only carries TCP, so a profile that goes through it needs Selkies in **WebSocket mode**.
`stream.mode` (*Server mode* in the editor, overridable per profile) says which transport the server runs:
`auto` means WebSocket for a Tailscale profile and "don't care" otherwise; an explicit `webrtc` with Tailscale is refused.
The client cannot change the server's mode (the web UI follows the server) and cannot drive the
[RemoteControl bot](../RemoteControl), which is a Discord bot. So the mode is asked on the server side:

```
/start selkies mode:websocket        (Discord bot; add funnel:True to expose it on the Internet as well)
```

If the page nevertheless opens a WebRTC connection, the client shows a warning with that command (best effort:
it watches `RTCPeerConnection`). Without Tailscale the server's default (WebRTC) keeps working as before.

**Limits**

- WebSocket mode only, no UDP relay: expect the cost of video over TCP (head-of-line blocking on lossy links) and of
  userspace WireGuard. Check 1080p60 on your link; lower the bitrate limit if needed.
- The server must be a node of the tailnet (MagicDNS name or 100.x address). Subnet routers and exit nodes are not used.
- Chromium has no SOCKS5 authentication, so any local process can connect to the proxy port, but it can only reach the
  profile that is currently open.
- One tailnet identity per app. The device name and auth settings are global; changing them restarts the sidecar on
  the next connection. The QUIC switch needs a restart of the app after enabling Tailscale.
- There is no main-process network traffic related to a profile today; if some is added it must use
  `session.fromPartition('persist:tailscale')` (e.g. `ses.fetch`), not the global `net`.
- Linux and Windows (amd64) only; the sidecar adds ~22 MB to the package.

**Checking for leaks without root**: run the app and a `tcpdump` inside a user + network namespace
(`unshare -Urn`) that only has `lo` and a dummy interface carrying the default route. Everything that does not
go through the loopback proxy then shows up on the dummy interface. With the sidecar's tailnet side replaced by a stub,
startup, an idle launcher and a Tailscale session whose page tries WebRTC/STUN, `fetch` and WebSocket to outside addresses
produce no packet on it, except two IGMP reports when the page opens a WebRTC connection (a WebSocket-mode page
produces none). A direct profile in the same run is clearly visible there (TCP SYNs, STUN over UDP).

## Building

Everything goes through the `Makefile` (run `make help`):

| Command | Result |
| --- | --- |
| `make sidecar` | Tailscale sidecar for linux/amd64 and windows/amd64 in `sidecar/bin/` (Go; the first build downloads the Go toolchain and modules) |
| `make sidecar-test` | Go tests of the sidecar (SOCKS5 server and destination policy) |
| `make build` | Sidecar + Linux AppImage + Windows portable exe |
| `make build-linux` | `dist/Selkies Client-<version>-linux.AppImage` |
| `make build-win` | `dist/Selkies Client-<version>-win.exe` (signed) |
| `make cert` | Regenerate the self-signed code-signing certificate in `certs/` |
| `make clean` / `make distclean` | Remove `dist/` / also `node_modules/`, `certs/`, `tools/`, `sidecar/bin/` |

Notes:

- Both targets are built from Linux. The AppImage can be run with
  `chmod +x` (add `--appimage-extract-and-run` if FUSE is unavailable).
- **Signing**: `make build-win` creates a self-signed certificate (`certs/`,
  password `selkies`, override with `CERT_PASS=…`) and signs the exe with
  `osslsigncode`. The one bundled with electron-builder needs libcrypto 1.1,
  so the Makefile installs its own copy into `tools/` without root: it extracts
  the distribution package (`apt-get download`) when apt exists, otherwise (e.g. Arch)
  it builds it from source (needs `cmake`, `gcc`, OpenSSL and libcurl headers). A self-signed signature is **not trusted** by Windows:
  SmartScreen will still warn. To fix that, buy a certificate from a trusted CA and run
  `WIN_CSC_LINK=cert.pfx WIN_CSC_KEY_PASSWORD=… npm run dist:win`.
- Never commit `certs/`.
- The sidecar goes into the package through `extraResources` (`resources/sidecar/`); in dev it is read from `sidecar/bin/`.
- Icon: `build/icon.png` (512×512).

## Project layout

```
src/main.js            launcher + stream windows, keyboard capture, hooks, TLS/auth/permissions, per-profile proxy session
src/config.js          config read/write, profiles, CLI arguments, stream settings, Tailscale options
src/tailscale.js       runs the Tailscale sidecar on demand and tracks its state
src/preload-stream.js  seeds bitrate/quality into the Selkies page's localStorage, reports WebRTC use
sidecar/               Go + tsnet: SOCKS5 proxy on 127.0.0.1 (main.go, socks.go, policy.go)
src/ui/                launcher (index.html, app.js, style.css, preload.js)
build/icon.png   application icon
Makefile         install / start / build / sign
```
