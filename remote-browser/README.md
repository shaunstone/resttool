# Remote Browser

Runs a real Chromium browser on your home Linux server and streams its tabs to any web browser: laptop, phone or tablet. You see the tab live, and your clicks, scrolling, typing and touch go back to it. The browser stays at home, so its cookies, logins and IP address stay there too.

> This folder has nothing to do with the Java `resttool` project in the rest of the repo. It's a standalone Node.js app.

## How it works

```
 your phone/laptop                         home server
┌──────────────────┐   HTTPS + WebSocket  ┌─────────────────────────────┐
│  web page        │  ◄── JPEG frames ─── │  server.js ── CDP ──► Chromium│
│  (canvas + UI)   │  ─── mouse/keys ───► │  (Node)            (headless)│
└──────────────────┘                      └─────────────────────────────┘
```

* `server.js` starts Chromium with [puppeteer-core](https://pptr.dev) and a persistent profile in `data/profile`.
* It uses the Chrome DevTools Protocol's `Page.startScreencast` to get JPEG frames of the active tab. Chromium only sends a frame when something on screen changes, and the server sends them to viewers over a WebSocket.
* The viewer page draws the frames on a canvas and sends input back. The server replays it with `Input.dispatchMouseEvent`, `dispatchKeyEvent`, `dispatchTouchEvent` and `insertText`.
* The remote viewport is resized to fit your window, so pages lay out for the screen you're actually on.

## Features

* Tabs: a tab strip, new tab, close tab, and popups / `target=_blank` links open as new tabs.
* Address bar (type a URL or a search), plus back, forward and reload.
* Mouse: click, double/triple click, right click, drag, and the wheel.
* Keyboard, including shortcuts. On a Mac, ⌘ is mapped to Ctrl because the remote browser runs on Linux.
* Clipboard both ways: paste with Ctrl/⌘+V, and copying with Ctrl/⌘+C or X puts the selected text on *your* clipboard (needs HTTPS).
* Phones: real touch events, so swiping and pinching scroll and zoom natively. A ⌨ button brings up the on-screen keyboard, and a "Mobile site mode" option is in the menu.
* `alert`/`confirm`/`prompt` dialogs from the page pop up on your screen.
* Open tabs and logins survive restarts.
* Several viewers can watch and control the same tab at once.
* Password login with a signed cookie, plus brute-force lockout (10 failures in 15 minutes).
* Can be installed to your phone's home screen (PWA manifest), with a fullscreen / hide-toolbar mode.

## Quick start (directly on the server)

Needs Node.js 18+ and Chromium or Chrome.

```bash
# Debian/Ubuntu
sudo apt install chromium        # or: chromium-browser / google-chrome-stable

cd remote-browser
npm install
cp .env.example .env
nano .env                        # set PASSWORD at minimum
npm start
```

Open `http://<server-ip>:3300` and log in.

### Run it as a service (systemd)

```bash
sudo cp -r remote-browser /opt/remote-browser
cd /opt/remote-browser && npm install --omit=dev
sudo cp deploy/remote-browser.service /etc/systemd/system/
sudo nano /etc/systemd/system/remote-browser.service   # set User= to your Linux user
sudo systemctl daemon-reload
sudo systemctl enable --now remote-browser
journalctl -u remote-browser -f
```

## Quick start (Docker)

```bash
cd remote-browser
cp .env.example .env && nano .env
docker compose up -d --build
```

The Chromium profile is kept in `./data`.

## Putting it on a domain (like pool.shaunstone.com)

Put it behind the same reverse proxy you use for your other subdomains, for example `browser.shaunstone.com`. Use **HTTPS**: it protects your password and the stream, and the browser only allows clipboard sync on secure pages.

* **Caddy**: see `deploy/Caddyfile`. It's two lines, and Caddy gets the certificate for you.
* **nginx**: see `deploy/nginx.conf`, then run `sudo certbot --nginx -d browser.shaunstone.com`. Keep the `Upgrade`/`Connection` headers, because the stream is a WebSocket.
* **Cloudflare Tunnel**: point a public hostname at `http://localhost:3300`. WebSockets work by default.

Once a proxy is in front, you can set `HOST=127.0.0.1` so the app isn't reachable directly on your LAN.

DNS: add an `A` record for `browser` pointing to your home IP (or a `CNAME` to whatever `pool` points to), and make sure ports 80/443 are forwarded to the proxy, the same as for your existing site.

## Configuration

All settings are environment variables, which can live in `.env` (see `.env.example`):

| Variable | Default | What it does |
| --- | --- | --- |
| `PASSWORD` | — (required) | Login password |
| `PORT` / `HOST` | `3300` / `0.0.0.0` | Where to listen |
| `START_URL` | `https://www.google.com` | First page on the very first run |
| `DATA_DIR` | `./data` | Chromium profile, saved tabs, session secret |
| `CHROME_PATH` | auto-detected | Chromium/Chrome binary |
| `JPEG_QUALITY` | `70` | Stream quality (lower uses less bandwidth) |
| `MAX_DPR` | `2` | Highest pixel ratio for "Sharp (HiDPI) frames" |
| `SESSION_DAYS` | `30` | How long a login lasts |
| `NO_SANDBOX` | off (on as root) | Disable the Chromium sandbox if it won't start |
| `HEADLESS` | `true` | `false` shows a real window (needs a display or Xvfb) |
| `AUTH` | — | `none` turns off the built-in login (only use it behind Cloudflare Access, Authelia, Tailscale, etc.) |
| `SESSION_SECRET` | random, saved in `DATA_DIR` | Cookie signing key |

## Tips

* **Bandwidth**: frames are sent only when the screen changes. A static page uses almost nothing, while video plays at a few Mbit/s. Lower `JPEG_QUALITY` on slow connections.
* **Sound isn't streamed**, only the picture.
* **Shortcuts the viewer's own browser keeps for itself**, like Ctrl+W, Ctrl+T and Ctrl+Tab, can't be captured. Use the tab strip instead, or install it as an app or go fullscreen, which lets more keys through.
* **Ctrl+L** jumps to the address bar.
* Logging into sites works as normal, and the sessions stay on your server.

## Security notes

Anyone who logs in gets full control of a browser **on your home network**. They can open your router page and other LAN services, and use any site you're logged into. So:

* Use a long, unique `PASSWORD`, and always use HTTPS.
* For extra protection, put it behind Cloudflare Access, Authelia or Tailscale.
* `data/profile` holds the browser's cookies and saved logins. Treat it like a password file.
