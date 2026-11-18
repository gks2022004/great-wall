# 🧱 Great Wall

An endless white wall on the internet for everything you love — photos, memes, songs, voice recordings, links and notes. Drag the canvas anywhere, zoom in and out, and pin things wherever you like.

Files are stored in **Telegram**, which works like a free S3 bucket: every upload becomes a document in a private channel, and the wall itself is saved as a pinned JSON message there. Your server keeps no state that matters, so you can redeploy it, or move it somewhere else, and the wall comes back.

## What you can pin

| | How |
|---|---|
| 🖼 Photos & memes (png, jpg, gif, webp…) | **Upload**, drag files onto the wall, or paste from the clipboard |
| 🎵 Songs (mp3, m4a, flac, wav…) | Upload, the same way; they play right on the wall |
| 🎙 Voice recordings | **Record** (or press `R`), then **Save** |
| 🔗 Links with previews | **Link** (or `L`), or paste/drop a URL. You get the title, description, image and site icon |
| ▶️ YouTube, Spotify, SoundCloud, Vimeo, Apple Music | Paste the link and it turns into a player |
| 🖼 Image / mp3 URLs | Paste them. The file is downloaded and kept, so it can't go missing later |
| 📝 Notes | Double-click empty space, **Note**, or `N` |
| 📦 Anything else | Upload it and it shows as a downloadable file card |

## Moving around

- **Drag** empty space to pan. You can also hold **Space** and drag, or use the middle mouse button.
- **Mouse wheel** zooms toward the cursor. **Pinch** or **Ctrl + scroll** zooms on a trackpad, and two-finger scroll pans.
- **F** fits everything on screen, **0** goes back to 100%, **+ / −** zoom, and the arrow keys pan.
- **Double-click** a photo, video or player to zoom to it.
- On a phone, drag with one finger and pinch with two.

When you're unlocked (editing):
- **Drag** an item to move it, and use the blue handle to resize it.
- Click an item to select it. Its toolbar has note colours, caption, open/download and delete. **Delete** / **Backspace** also removes it.
- **Double-click** a note to edit it. Click outside, or press **Ctrl/⌘ + Enter**, to finish.

Visitors see the wall read-only. Press **Edit** in the corner and enter your password to unlock it.

## Setup

Requires Node 22.9+.

```bash
npm install
cp .env.example .env     # then fill it in
npm start                # http://localhost:3000
```

With no Telegram settings, files go to `./data/uploads`. That's fine for trying it out locally.

### Telegram as storage

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the **token** into `TELEGRAM_BOT_TOKEN`.
2. Create a **private channel** (e.g. "Great Wall storage").
3. Add your bot to the channel as an **administrator** with permission to *post*, *edit*, *delete* and *pin* messages.
4. Get the channel id. Forward any message from the channel to [@userinfobot](https://t.me/userinfobot) or [@RawDataBot](https://t.me/RawDataBot); it looks like `-1001234567890`. Put it in `TELEGRAM_CHAT_ID`.
5. Set `ADMIN_PASSWORD` and a long random `SESSION_SECRET` (`openssl rand -hex 32`).
6. `npm start`. The log should say `storing files via @yourbot`.

How it's stored:

- Each file is sent to the channel with `sendDocument`. The `file_id` Telegram returns is the object key.
- The Bot API only lets bots download files up to **20 MB**, so bigger files are split into 19 MB parts and put back together on download. That means any file up to `MAX_UPLOAD_MB` (default 200) works.
- The browser never talks to Telegram. Files are streamed through `/f/<id>`, so your bot token stays private. Range requests let audio and video seek.
- Downloaded files are kept in an LRU disk cache (`CACHE_MAX_MB`), so popular items are served from the cache.
- The wall layout (`wall.json`) is written to disk on every change and mirrored to a **pinned message** in the channel a few seconds later. It is edited in place, not reposted. On startup, the server uses whichever copy is newer.
- Deleting an item also deletes its messages from the channel.

To go beyond 20 MB per part, run your own [Bot API server](https://github.com/tdlib/telegram-bot-api) and set `TELEGRAM_API_URL`.

## Deploying

Any host that runs Node or Docker will work (Render, Railway, Fly.io, a VPS…). The only state that matters lives in Telegram, so an ephemeral disk is fine. You just start with a cold cache.

```bash
docker build -t great-wall .
docker run -d -p 3000:3000 --env-file .env -v great-wall-data:/data great-wall
```

Put it behind HTTPS (most hosts do this for you) so the login cookie is marked `Secure`. If your proxy isn't on a private network, set `TRUST_PROXY` (e.g. `TRUST_PROXY=1`).

## Configuration

| Variable | Default | |
|---|---|---|
| `ADMIN_PASSWORD` | – | Unlocks editing. **If it's unset, anyone can edit.** |
| `SESSION_SECRET` | random per boot | Signs the login cookie |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | – | Turns on Telegram storage |
| `TELEGRAM_API_URL` | `https://api.telegram.org` | For a self-hosted Bot API server |
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` | Local wall copy, cache, local uploads |
| `MAX_UPLOAD_MB` | `200` | Per-file limit |
| `CACHE_MAX_MB` | `1024` | Disk cache for files pulled from Telegram |

## Project layout

```
server/
  index.js      HTTP API, auth, file serving
  telegram.js   tiny Bot API client (upload, edit, download, pin)
  storage.js    object store: Telegram (chunked) or local disk, plus the LRU cache
  wall.js       wall state, persistence and Telegram snapshot
  preview.js    link previews, embeds, SSRF-safe fetching
public/
  index.html, style.css, app.js   the infinite canvas (no framework, no build step)
```
