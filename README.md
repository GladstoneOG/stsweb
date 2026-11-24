# Slay the Spire Web (`stsweb`) — 1–6P Shared-Battlefield Co-op & Seed Race

A browser-native WebGL2 port of **Slay the Spire (V2.3.4)** compiled with **gdx-teavm + LibGDX 1.14.2 + FreeType WASM**, featuring **1–6 player online Co-op** and **Seed Race** over **Cloudflare Workers + Hibernatable SQLite Durable Objects + WebRTC P2P DataChannels**, with portable account cloud saves.

### Play Online on Cloudflare Workers
- **Live Worker URL:** [https://stsweb.johansans999.workers.dev](https://stsweb.johansans999.workers.dev)
- **GitHub Repository:** [https://github.com/GladstoneOG/stsweb](https://github.com/GladstoneOG/stsweb)

---

## Features

- **1–6 Player Shared-Battlefield Co-op & Seed Race:**
  - Host or join rooms with a 5-letter code, invite link (`?room=XXXXX`), or live room browser (`Public Spire Parties`).
  - Simultaneous turns with an End-Turn barrier, shared scaled enemies (`+80%` HP per extra player), deterministic per-monster target indicators, ally Spine idle characters with live HP/Block bars, map node voting with chalk rings, downed spectator mode + campfire revives, and gold/potion/card trading.
- **Portable Username/Password Cloud Saves (SQLite DO):**
  - Automatic profile & savefile synchronization backed by Cloudflare SQLite Durable Objects (`StsLobbyHub`), alongside Vanilla Steam `.autosave` / `preferences/` import & export and 3 manual cloud backup snapshots.
- **Free Tier Friendly Room Lifecycle:**
  - Empty rooms are unlisted immediately when all players disconnect, and idle/abandoned rooms automatically dissolve after **1 minute** of inactivity (`StsRoomDO.alarm()` + `deleteAll()` SQLite cleanup) with activity-gated client heartbeats.
- **Cloudflare Workers Free Plan Ready:**
  - Every static asset in `public/` is `<= 16.00 MiB` (`boot.part00..05.bin` + `acts.part00..01.bin` cached locally in `IndexedDB` `stsweb_vfs_v1` + streamed `.ogg` music).

---

## Controls

| Action | Key / Input |
| :--- | :--- |
| **Play Cards / Map / Menus** | Mouse (`1–9` card hotkeys) |
| **End Turn** | `E` or **End Turn** button |
| **View Map / Deck / Discard / Draw** | `M` / `D` / `S` / `A` |
| **Open Spire Net & Cloud Saves** | `F2` (or hover the left Spire Net pill) |
| **Toggle Floating HUD** | `F9` |
| **Toggle Fullscreen** | `F11` |

---

## Local Development

```bash
cd stsweb
npm install
npm run cf:dev
# Or standalone Node + WS + SQLite server:
# npm start
```

Open `http://127.0.0.1:8788/` (or multiple browser tabs for local 2P–6P Co-op testing). You can override the relay via `?relay=http://127.0.0.1:8788` or [`public/relay_config.js`](./public/relay_config.js).

---

## Deploying to Cloudflare Workers (Free Plan)

Configured in [`wrangler.toml`](./wrangler.toml) with Workers Static Assets (`./public`) and Hibernatable SQLite Durable Objects (`StsLobbyHub`, `StsRoomDO`):

```bash
cd stsweb
npx wrangler login
npx wrangler deploy
```

### Connecting GitHub (`GladstoneOG/stsweb`) to Cloudflare Workers Builds
When connecting `GladstoneOG/stsweb` in **Cloudflare Dashboard → Workers & Pages → `stsweb` → Settings → Builds**:
- **Build command:** *(leave empty — TeaVM bundle & chunked VFS packs are prebuilt in `public/`)*
- **Deploy command:** `npx wrangler deploy`
- Workers Static Assets (`./public`), API routes (`/api/*`), WebSocket relay (`/ws`), and SQLite Durable Object migrations are applied automatically from [`wrangler.toml`](./wrangler.toml).

---

## Rebuilding Java / Assets Locally (Optional)

Requires the Steam installation of Slay the Spire (`desktop-1.0.jar`) and JDK 21:

```bash
npm run setup
npm run build:assets
npm run decompile
npm run build:java
```
