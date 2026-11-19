# ScanDrop

**Scan it. Get it.** Share files with a single scan.

Upload a file, and ScanDrop gives you a QR code. Anyone who scans it with a phone camera gets a download page for the file. No sign-up and no app install. Files delete themselves automatically.

Two ways to send:

| | **Upload & share** | **Send directly** |
|---|---|---|
| How | File is stored (encrypted) on the server | File goes device to device (WebRTC) |
| Sender must stay online | No | Yes, until it's received |
| Size limit | 2 GB (configurable) | None |
| Server can read the file | No (end-to-end encrypted) | Never touches the server |

## Features

**Sending**
- Drag-and-drop upload with progress, speed and time left
- **Chunked, resumable uploads:** files go up in 8 MB pieces, 3 at a time
  - Failed pieces retry automatically with backoff
  - **Pause / Resume** at any time
  - If the connection drops, the tab closes, or the browser crashes, pick the same file again and the upload continues where it stopped
- Files up to 2 GB by default (configurable)

**Sharing**
- QR code and copyable share link
- **Share the QR:** opens the device's share sheet (WhatsApp, Telegram, Bluetooth, email…) with a QR image card and the link. Browsers without a share sheet get a built-in menu (WhatsApp, Telegram, Email, SMS, Save image, Copy link)
- **Save image:** download the QR as a PNG card with the file name, ready to print or post
- **Auto-expiry:** 10 minutes, 1 hour, 24 hours or 7 days
- **Download limits:** 1 (one-time link), 5, 10 or unlimited
- **PIN protection (optional, 4–8 digits):** the file name and contents stay hidden until the right PIN is entered. Five wrong tries locks the file for 10 minutes
- Live download count for the sender

**End-to-end encryption (on by default)**
- Each file is encrypted in the sender's browser with its own random AES-256-GCM key
- The key is only in the QR link, after `#`. Browsers never send that part to the server
- The server stores only ciphertext. Even the file name and type are encrypted
- The receiver's browser decrypts as it downloads, streaming to disk on Chrome/Edge
- Works on phones opening plain `http://` addresses too: falls back to the audited [@noble/ciphers](https://github.com/paulmillr/noble-ciphers) when WebCrypto isn't available

**Direct transfer (P2P)**
- Pick "Send directly" and the receiver scans. The file streams straight between the two browsers
- No size limit and no server storage. WebRTC traffic is encrypted (DTLS)
- Several people can receive one after another while the sender keeps the page open
- The server only relays tiny connection messages (Server-Sent Events + POST)

**Receiving**
- Mobile-friendly download page with resumable downloads (HTTP Range)

**Safety**
- Only the sender can delete a file early (secret owner token kept in their browser)
- Rate limits on uploads, PIN attempts and API calls
- Total storage cap, so the disk can't fill up
- Random 12-character IDs, cleaned file names, slow-hashed PINs, signed short-lived download tokens

## Getting started

Requires **Node.js 18+**.

```bash
npm install
npm start
```

Open http://localhost:3000.

When the server starts, it prints the address used inside QR codes, for example `http://192.168.1.5:3000`. To scan from a phone, **the phone must be on the same Wi-Fi as this computer**. On Windows, allow Node.js through the firewall when asked.

For development with auto-restart:

```bash
npm run dev
```

## Tests

```bash
npm test
```

Runs 44 automated tests against real server instances (each with its own temporary storage):
uploads and chunk resume, parallel 25 MB uploads, non-English file names, download limits
(including interrupted and resumed one-time downloads), PIN lockout and token checks,
end-to-end encryption (ciphertext only on the server, tamper and reorder detection,
phone-fallback compatibility), expiry cleanup, restart persistence, storage cap,
rate limits, path tricks, security headers, and P2P signaling.

## Configuration

Set these as environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `PUBLIC_URL` | LAN IP + port | Base URL put in QR codes. Set this when deployed, e.g. `https://scandrop.app` |
| `MAX_FILE_MB` | `2048` | Max size of one file, in MB |
| `MAX_STORAGE_GB` | `20` | Max total space for all files, in GB |
| `CHUNK_MB` | `8` | Upload piece size, in MB |
| `STORAGE_DIR` | `./storage` | Where files, metadata and the server secret are stored |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy so rate limits see real client IPs |
| `STUN_URLS` | Google public STUN | Comma-separated STUN servers for direct transfers (empty = same network only) |

## How an upload works

```
Browser                                   Server
  POST /api/uploads {name,size,...}  ───▶  creates upload, returns uploadId + chunkSize
  PUT  /api/uploads/:uid/chunks/0    ───▶  writes bytes at offset 0
  PUT  /api/uploads/:uid/chunks/1    ───▶  ...3 chunks in parallel, retried on failure
  ... (paused / page closed) ...
  GET  /api/uploads/:uid             ───▶  "I already have chunks 0-9"   ← resume
  PUT  remaining chunks              ───▶
  POST /api/uploads/:uid/complete    ───▶  file becomes shareable → { id, url, ownerToken }
```

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/config` | Limits and options |
| `POST` | `/api/uploads` | Start an upload: `{ name, size, mime, expiry, maxDownloads, pin? }` |
| `GET` | `/api/uploads/:uid` | Chunks already received (for resuming) |
| `PUT` | `/api/uploads/:uid/chunks/:index` | Upload one chunk (raw bytes) |
| `POST` | `/api/uploads/:uid/complete` | Finish. Returns file info and `ownerToken` |
| `DELETE` | `/api/uploads/:uid` | Cancel an upload |
| `GET` | `/api/files/:id` | File info (limited for PIN files unless unlocked or owner) |
| `POST` | `/api/files/:id/unlock` | `{ pin }` returns a temporary download token |
| `GET` | `/api/files/:id/qr.svg` | QR code image |
| `GET` | `/api/files/:id/download` | Download (`?t=<token>` for PIN files) |
| `DELETE` | `/api/files/:id` | Delete now (needs `X-Owner-Token` header) |
| `POST` | `/api/p2p` | Open a direct-transfer room. Returns `{ roomId, token, url }` |
| `POST` | `/api/p2p/:id/join` | Receiver joins. Returns `{ token }` |
| `GET` | `/api/p2p/:id/events?token=` | Server-Sent Events: `peer-joined`, `peer-left`, `signal`, `room-closed` |
| `POST` | `/api/p2p/:id/signal` | `{ token, data }` relayed to the other device |
| `GET` | `/d/:id` | Download page (the URL inside the QR; encrypted links add `#key`) |
| `GET` | `/p/:id` | Direct-transfer receive page |

Encrypted uploads send `{ encrypted: true, size: <ciphertext size>, meta: <encrypted details> }` instead of `name`/`mime`.

## Project structure

```
server.js              App setup, rate limits, cleanup job
src/config.js          Settings and LAN-IP detection
src/store.js           JSON-file metadata store
src/security.js        PIN hashing, tokens, rate limiter
src/util.js            File name / MIME cleaning
src/routes/uploads.js  Chunked upload API
src/routes/files.js    Info, unlock, QR, download, delete
src/routes/p2p.js      Signaling for direct transfers
public/                Frontend (plain HTML/CSS/JS)
  index.html           Upload page
  download.html        Page opened by scanning the QR
  receive.html         Page opened by scanning a direct-transfer QR
  js/uploader.js       Resumable chunked uploader (encrypts pieces when enabled)
  js/e2e.js            AES-256-GCM encryption, keys in the link fragment
  js/p2p.js            WebRTC direct transfer (sender + receiver)
  js/save.js           Save streamed files (disk stream or Blob download)
  js/qr.js             In-browser QR codes (keeps keys off the server)
  js/receive.js        Direct-transfer receive page logic
  js/app.js            Upload page logic
  js/download.js       Download page logic
storage/               Files, metadata, secret (git-ignored)
```

## Roadmap

- [x] v1: upload, QR, download page, expiry, download limits
- [x] v2: chunked/resumable uploads, PIN links, rate limiting, owner-only delete, storage cap
- [x] v3: end-to-end encryption in the browser, direct peer-to-peer transfer (WebRTC)
- [ ] Cloud storage (Cloudflare R2 / S3) with pre-signed URLs, so the server never carries file bytes
- [ ] TURN server for direct transfers across strict networks (some office and mobile networks block P2P)
- [ ] HTTPS for local network use
