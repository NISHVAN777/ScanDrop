# ScanDrop

**Scan it. Get it.** Share files with a single scan.

Upload a file, and ScanDrop gives you a QR code. Anyone who scans it with a phone camera gets a download page for the file. No sign-up and no app install. Files delete themselves automatically.

## Features (v1)

- Drag-and-drop upload with a live progress bar, speed and time left
- QR code and copyable share link for every file
- Download page that works on any phone or computer
- **Auto-expiry:** 10 minutes, 1 hour, 24 hours or 7 days
- **Download limits:** 1 (one-time link), 5, 10 or unlimited
- Sender can delete the file early
- Large files supported (default limit 2 GB). Uploads stream straight to disk, so RAM stays low
- Resumable downloads (HTTP Range requests)
- Light and dark mode, mobile-friendly

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
| `MAX_FILE_MB` | `2048` | Max upload size in MB |
| `STORAGE_DIR` | `./storage` | Where files and the metadata DB are stored |

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/config` | Upload limits and options |
| `POST` | `/api/upload` | Multipart upload: `file`, plus optional `expiry` and `maxDownloads` |
| `GET` | `/api/files/:id` | File info |
| `GET` | `/api/files/:id/qr.svg` | QR code image |
| `GET` | `/api/files/:id/download` | Download the file |
| `DELETE` | `/api/files/:id` | Delete the file now |
| `GET` | `/d/:id` | Download page (the URL inside the QR) |

## Project structure

```
server.js            Express server: upload, download, QR, cleanup
src/config.js        Settings and LAN-IP detection
src/store.js         JSON-file metadata store
public/              Frontend (plain HTML/CSS/JS)
  index.html         Upload page
  download.html      Page opened by scanning the QR
  js/ css/
storage/             Uploaded files and the DB (git-ignored)
```

## Roadmap

- **v2:** chunked/resumable uploads, PIN-protected links, cloud storage (Cloudflare R2 / S3 with pre-signed URLs), rate limiting
- **v3:** end-to-end encryption in the browser, peer-to-peer transfer (WebRTC) for unlimited sizes
