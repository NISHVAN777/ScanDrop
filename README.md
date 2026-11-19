# ScanDrop

**Scan it. Get it.** Share files with a single scan.

Upload a file, and ScanDrop gives you a QR code. Anyone who scans it with a phone camera gets a download page for the file. No sign-up and no app install. Files delete themselves automatically.

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
- **Auto-expiry:** 10 minutes, 1 hour, 24 hours or 7 days
- **Download limits:** 1 (one-time link), 5, 10 or unlimited
- **PIN protection (optional, 4–8 digits):** the file name and contents stay hidden until the right PIN is entered. Five wrong tries locks the file for 10 minutes
- Live download count for the sender

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
| `GET` | `/d/:id` | Download page (the URL inside the QR) |

## Project structure

```
server.js              App setup, rate limits, cleanup job
src/config.js          Settings and LAN-IP detection
src/store.js           JSON-file metadata store
src/security.js        PIN hashing, tokens, rate limiter
src/util.js            File name / MIME cleaning
src/routes/uploads.js  Chunked upload API
src/routes/files.js    Info, unlock, QR, download, delete
public/                Frontend (plain HTML/CSS/JS)
  index.html           Upload page
  download.html        Page opened by scanning the QR
  js/uploader.js       Resumable chunked uploader
  js/app.js            Upload page logic
  js/download.js       Download page logic
storage/               Files, metadata, secret (git-ignored)
```

## Roadmap

- [x] v1: upload, QR, download page, expiry, download limits
- [x] v2: chunked/resumable uploads, PIN links, rate limiting, owner-only delete, storage cap
- [ ] Cloud storage (Cloudflare R2 / S3) with pre-signed URLs, so the server never carries file bytes
- [ ] v3: end-to-end encryption in the browser, peer-to-peer transfer (WebRTC) for unlimited sizes
