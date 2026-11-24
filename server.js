#!/usr/bin/env node
/**
 * Slay the Spire Web (stsweb) — Full Local Development Server
 * Supports static assets, Hibernatable-compatible /ws Co-op & Seed Race rooms,
 * PBKDF2 authentication, and SQLite portable account/slot save persistence.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = parseInt(process.env.PORT || "8788", 10);
const PUBLIC_DIR = path.join(__dirname, "public");
const DB_DIR = path.join(__dirname, ".wrangler");
const DB_PATH = path.join(DB_DIR, "local-stsweb.sqlite");
const MAX_PLAYERS_PER_ROOM = 6;
const ROOM_INACTIVITY_TTL_MS = 60 * 1000; // Dissolve room after 1 min of no activity
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".bin": "application/octet-stream",
  ".wasm": "application/wasm",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".fnt": "text/plain; charset=utf-8",
  ".glsl": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ----------------------------------------------------------------------------
// SQLite Store (Node 24 node:sqlite DatabaseSync)
// ----------------------------------------------------------------------------

fs.mkdirSync(DB_DIR, { recursive: true });
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS account_saves (
    user_id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS saves (
    user_id INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    label TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, slot)
  );
`);

function hashPassword(password, saltHex) {
  return crypto.pbkdf2Sync(password, Buffer.from(saltHex, "hex"), 100000, 32, "sha256").toString("hex");
}

function getSessionUser(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const row = db.prepare("SELECT user_id, username, expires_at FROM sessions WHERE token = ?").get(token);
  if (!row || row.expires_at < Date.now()) {
    if (row) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  return { userId: row.user_id, username: row.username };
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    ...CORS_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 2 * 1024 * 1024 + 4096) chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (_) {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

// ----------------------------------------------------------------------------
// In-Memory Co-op & Seed Race Rooms (Mirrors StsRoomDO Protocol)
// ----------------------------------------------------------------------------

const rooms = new Map();

function normalizeRoomCode(raw) {
  const clean = String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  return clean.slice(0, 16) || "SPIRE";
}

function generateSeedLongString() {
  const hi = BigInt(crypto.randomInt(1, 0x7fffffff));
  const lo = BigInt(crypto.randomInt(0, 0xffffffff));
  return ((hi << 32n) | lo).toString();
}

function getOrCreateRoom(code, hostId, mode, ascension, seedText) {
  let r = rooms.get(code);
  if (r) return r;
  r = {
    code,
    hostId,
    mode: mode === "RACE" ? "RACE" : "COOP",
    seedText: seedText || "",
    seedLong: generateSeedLongString(),
    ascension: Math.max(0, Math.min(20, Number(ascension || 0))),
    state: "LOBBY",
    floorNum: 0,
    actNum: 1,
    turnNum: 1,
    nextSeq: 1,
    players: new Map(), // playerId -> player obj
    sockets: new Set(), // WebSocket
    checkpoints: new Map(),
    combatActions: [],
    updatedAt: Date.now(),
  };
  rooms.set(code, r);
  return r;
}

function listRoomsSummary() {
  const now = Date.now();
  const out = [];
  for (const r of rooms.values()) {
    if (now - r.updatedAt > ROOM_INACTIVITY_TTL_MS || r.state === "ENDED") continue;
    const players = Array.from(r.players.values());
    const connected = players.filter((p) => p.connected);
    if (connected.length === 0) continue;
    const host = players.find((p) => p.playerId === r.hostId) || connected[0] || players[0];
    out.push({
      code: r.code,
      host_name: host ? host.name : "Player",
      mode: r.mode,
      ascension: r.ascension,
      player_count: connected.length,
      max_players: MAX_PLAYERS_PER_ROOM,
      state: r.state,
      floor_num: r.floorNum,
      act_num: r.actNum,
      joinable: connected.length < MAX_PLAYERS_PER_ROOM ? 1 : 0,
      updated_at: r.updatedAt,
    });
  }
  out.sort((a, b) => b.updated_at - a.updated_at);
  return out;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms.entries()) {
    const idleMs = now - r.updatedAt;
    if (idleMs >= ROOM_INACTIVITY_TTL_MS) {
      for (const s of r.sockets) {
        if (s.readyState === WebSocket.OPEN) {
          try {
            s.send(JSON.stringify({ type: "ERROR", message: "Room closed due to inactivity." }));
            s.close(4000, "Room closed due to inactivity");
          } catch (_) {}
        }
      }
      rooms.delete(code);
    }
  }
}, 15000).unref();

function buildRoomSyncPayload(r) {
  const players = Array.from(r.players.values()).sort((a, b) => a.slot - b.slot);
  return {
    type: "ROOM_SYNC",
    room: {
      code: r.code,
      hostId: r.hostId,
      mode: r.mode,
      seedText: r.seedText,
      seedLong: r.seedLong,
      ascension: r.ascension,
      state: r.state,
      floorNum: r.floorNum,
      actNum: r.actNum,
      turnNum: r.turnNum,
      nextSeq: r.nextSeq,
    },
    players: players.map((p) => ({
      playerId: p.playerId,
      slot: p.slot,
      name: p.name,
      charClass: p.charClass,
      hp: p.hp,
      maxHp: p.maxHp,
      block: p.block,
      gold: p.gold,
      energy: p.energy,
      ready: p.ready,
      endTurnReady: p.endTurnReady,
      isDowned: p.isDowned,
      mapVoteX: p.mapVoteX,
      mapVoteY: p.mapVoteY,
      floorNum: p.floorNum,
      connected: p.connected,
    })),
  };
}

function broadcastRoom(r, obj, excludeWs = null) {
  const msg = typeof obj === "string" ? obj : JSON.stringify(obj);
  for (const s of r.sockets) {
    if (s !== excludeWs && s.readyState === WebSocket.OPEN) {
      try { s.send(msg); } catch (_) {}
    }
  }
}

function evaluateMapBarrier(r) {
  if (r.state !== "IN_RUN" || r.mode !== "COOP") return;
  const voters = Array.from(r.players.values()).filter((p) => p.connected && !p.isDowned);
  if (voters.length === 0 || voters.some((p) => p.mapVoteX < 0 || p.mapVoteY < 0)) return;
  const counts = new Map();
  for (const v of voters) {
    const k = `${v.mapVoteX}:${v.mapVoteY}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let bestKey = `${voters[0].mapVoteX}:${voters[0].mapVoteY}`;
  let bestCount = -1;
  for (const [k, c] of counts.entries()) {
    if (c > bestCount) { bestCount = c; bestKey = k; }
  }
  const [winX, winY] = bestKey.split(":").map((n) => parseInt(n, 10));
  r.floorNum += 1;
  r.turnNum = 1;
  r.combatActions = [];
  for (const p of r.players.values()) {
    p.mapVoteX = -1;
    p.mapVoteY = -1;
    p.endTurnReady = false;
  }
  broadcastRoom(r, { type: "MAP_ADVANCE", x: winX, y: winY, floorNum: r.floorNum });
  broadcastRoom(r, buildRoomSyncPayload(r));
}

function evaluateEndTurnBarrier(r) {
  if (r.state !== "IN_RUN" || r.mode !== "COOP") return;
  const living = Array.from(r.players.values()).filter((p) => p.connected && !p.isDowned);
  if (living.length === 0 || living.some((p) => !p.endTurnReady)) return;
  r.turnNum += 1;
  for (const p of r.players.values()) p.endTurnReady = false;
  broadcastRoom(r, { type: "ALL_PLAYERS_END_TURN", turnNum: r.turnNum });
  broadcastRoom(r, buildRoomSyncPayload(r));
}

function evaluateWipeBarrier(r) {
  if (r.state !== "IN_RUN" || r.mode !== "COOP") return;
  const alive = Array.from(r.players.values()).filter((p) => p.connected && !p.isDowned);
  if (alive.length === 0) {
    r.state = "ENDED";
    broadcastRoom(r, { type: "ALL_PLAYERS_WIPED" });
  }
}

// ----------------------------------------------------------------------------
// HTTP + Static Asset Server
// ----------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/api/time") {
    return sendJson(res, { epochSeconds: Math.floor(Date.now() / 1000) });
  }
  if (url.pathname === "/api/rooms") {
    return sendJson(res, { rooms: listRoomsSummary() });
  }
  if (url.pathname.startsWith("/api/room/")) {
    const code = normalizeRoomCode(url.pathname.slice("/api/room/".length));
    const r = rooms.get(code);
    return sendJson(res, r ? buildRoomSyncPayload(r) : { type: "ROOM_SYNC", room: null, players: [] });
  }

  if (url.pathname === "/api/auth/register" && req.method === "POST") {
    const body = await readJsonBody(req);
    const username = String(body?.username || "").trim();
    const password = String(body?.password || "");
    if (!/^[A-Za-z0-9_.-]{3,24}$/.test(username) || password.length < 4) {
      return sendJson(res, { error: "Username must be 3-24 chars (letters/numbers/_.-) and password >= 4 chars." }, 400);
    }
    const existing = db.prepare("SELECT id FROM accounts WHERE lower(username) = lower(?)").get(username);
    if (existing) return sendJson(res, { error: "Username already exists." }, 409);

    const salt = crypto.randomBytes(16).toString("hex");
    const passHash = hashPassword(password, salt);
    const now = Date.now();
    const info = db.prepare("INSERT INTO accounts (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)").run(
      username, passHash, salt, now
    );
    const userId = Number(info.lastInsertRowid);
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (token, user_id, username, expires_at) VALUES (?, ?, ?, ?)").run(
      token, userId, username, now + SESSION_TTL_MS
    );
    return sendJson(res, { token, username, hasSave: false, updated_at: null });
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    const body = await readJsonBody(req);
    const username = String(body?.username || "").trim();
    const password = String(body?.password || "");
    const acct = db.prepare("SELECT id, username, pass_hash, salt FROM accounts WHERE lower(username) = lower(?)").get(username);
    if (!acct || hashPassword(password, acct.salt) !== acct.pass_hash) {
      return sendJson(res, { error: "Invalid credentials." }, 401);
    }
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (token, user_id, username, expires_at) VALUES (?, ?, ?, ?)").run(
      token, acct.id, acct.username, Date.now() + SESSION_TTL_MS
    );
    const acctSave = db.prepare("SELECT updated_at FROM account_saves WHERE user_id = ?").get(acct.id);
    return sendJson(res, {
      token,
      username: acct.username,
      hasSave: !!acctSave,
      updated_at: acctSave ? acctSave.updated_at : null,
    });
  }

  if (url.pathname === "/api/auth/me" && req.method === "GET") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, { error: "Unauthorized" }, 401);
    const acctSave = db.prepare("SELECT length(payload_json) AS bytes, updated_at FROM account_saves WHERE user_id = ?").get(user.userId);
    return sendJson(res, {
      username: user.username,
      hasSave: !!acctSave,
      saveBytes: acctSave ? acctSave.bytes : 0,
      updated_at: acctSave ? acctSave.updated_at : null,
    });
  }

  if (url.pathname === "/api/account/save") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, { error: "Unauthorized" }, 401);
    if (req.method === "GET") {
      const row = db.prepare("SELECT payload_json, updated_at FROM account_saves WHERE user_id = ?").get(user.userId);
      return sendJson(res, {
        ok: true,
        username: user.username,
        hasSave: !!row,
        updated_at: row ? row.updated_at : null,
        payload: row ? JSON.parse(row.payload_json) : null,
      });
    }
    if (req.method === "PUT" || req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body || !body.payload || typeof body.payload !== "object") {
        return sendJson(res, { error: "Invalid save payload" }, 400);
      }
      const payloadStr = JSON.stringify(body.payload);
      if (payloadStr.length > 2 * 1024 * 1024) {
        return sendJson(res, { error: "Save bundle exceeds 2 MiB limit" }, 413);
      }
      const now = Date.now();
      db.prepare(`
        INSERT INTO account_saves (user_id, username, payload_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          username = excluded.username,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `).run(user.userId, user.username, payloadStr, now);
      return sendJson(res, { ok: true, username: user.username, bytes: payloadStr.length, updated_at: now });
    }
  }

  if (url.pathname === "/api/saves" && req.method === "GET") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, { error: "Unauthorized" }, 401);
    const rows = db.prepare("SELECT slot, label, length(payload_json) AS bytes, updated_at FROM saves WHERE user_id = ? ORDER BY slot ASC").all(user.userId);
    return sendJson(res, { username: user.username, slots: rows });
  }

  const slotMatch = url.pathname.match(/^\/api\/saves\/([1-3])$/);
  if (slotMatch) {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, { error: "Unauthorized" }, 401);
    const slot = parseInt(slotMatch[1], 10);
    if (req.method === "GET") {
      const row = db.prepare("SELECT slot, label, payload_json, updated_at FROM saves WHERE user_id = ? AND slot = ?").get(user.userId, slot);
      if (!row) return sendJson(res, { error: "Save slot empty" }, 404);
      return sendJson(res, { slot: row.slot, label: row.label, updated_at: row.updated_at, payload: JSON.parse(row.payload_json) });
    }
    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      if (!body || !body.payload || typeof body.payload !== "object") {
        return sendJson(res, { error: "Invalid save payload" }, 400);
      }
      const payloadStr = JSON.stringify(body.payload);
      const label = String(body.label || `Cloud Slot ${slot}`).slice(0, 48);
      const now = Date.now();
      db.prepare(`
        INSERT INTO saves (user_id, slot, label, payload_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, slot) DO UPDATE SET
          label = excluded.label, payload_json = excluded.payload_json, updated_at = excluded.updated_at
      `).run(user.userId, slot, label, payloadStr, now);
      return sendJson(res, { ok: true, slot, label, bytes: payloadStr.length, updated_at: now });
    }
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": ext === ".bin" || ext === ".wasm" || ext === ".ogg"
        ? "public, max-age=604800, immutable"
        : "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

// ----------------------------------------------------------------------------
// WebSocket Upgrade Handler (/ws)
// ----------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, url);
  });
});

wss.on("connection", (ws, req, url) => {
  const code = normalizeRoomCode(url.searchParams.get("room"));
  const playerId = String(url.searchParams.get("playerId") || "").trim() || crypto.randomUUID();
  const name = String(url.searchParams.get("name") || "Player").trim().slice(0, 20) || "Player";
  const charClass = String(url.searchParams.get("charClass") || "IRONCLAD").trim();
  const mode = String(url.searchParams.get("mode") || "COOP").trim().toUpperCase();
  const ascension = parseInt(url.searchParams.get("ascension") || "0", 10) || 0;
  const seedText = String(url.searchParams.get("seed") || "").trim();

  const r = getOrCreateRoom(code, playerId, mode, ascension, seedText);
  let player = r.players.get(playerId);
  if (!player) {
    if (r.players.size >= MAX_PLAYERS_PER_ROOM) {
      ws.send(JSON.stringify({ type: "ERROR", message: "Room is full (6/6 players)." }));
      ws.close(4003, "Room full");
      return;
    }
    const usedSlots = new Set(Array.from(r.players.values()).map((p) => p.slot));
    let freeSlot = 0;
    while (usedSlots.has(freeSlot) && freeSlot < MAX_PLAYERS_PER_ROOM) freeSlot++;
    player = {
      playerId,
      slot: freeSlot,
      name,
      charClass,
      hp: 80,
      maxHp: 80,
      block: 0,
      gold: 99,
      energy: 3,
      ready: false,
      endTurnReady: false,
      isDowned: false,
      mapVoteX: -1,
      mapVoteY: -1,
      floorNum: 0,
      connected: true,
    };
    r.players.set(playerId, player);
  } else {
    player.name = name;
    player.connected = true;
  }

  r.updatedAt = Date.now();
  r.sockets.add(ws);
  ws._room = r;
  ws._player = player;

  ws.send(JSON.stringify({ type: "WELCOME", playerId, slot: player.slot, roomCode: r.code }));
  const sync = buildRoomSyncPayload(r);
  ws.send(JSON.stringify(sync));

  if (r.state === "IN_RUN" && (r.checkpoints.size > 0 || r.combatActions.length > 0)) {
    const latestCp = r.checkpoints.get(r.floorNum) || null;
    ws.send(JSON.stringify({
      type: "CHECKPOINT_RESTORE",
      floorNum: r.floorNum,
      checkpoint: latestCp,
      actions: r.combatActions,
    }));
  }
  broadcastRoom(r, sync, ws);
  evaluateEndTurnBarrier(r);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString("utf8")); } catch (_) { return; }
    if (!msg || typeof msg.type !== "string") return;
    r.updatedAt = Date.now();

    switch (msg.type) {
      case "PING":
        ws.send(JSON.stringify({ type: "PONG", ts: Date.now() }));
        return;

      case "LEAVE_ROOM":
        r.sockets.delete(ws);
        player.connected = false;
        if (r.state === "LOBBY" && r.hostId === player.playerId) {
          const nextHost = Array.from(r.players.values()).find((p) => p.connected);
          if (nextHost) r.hostId = nextHost.playerId;
        }
        try { ws.close(1000, "Leave room"); } catch (_) {}
        broadcastRoom(r, buildRoomSyncPayload(r));
        evaluateMapBarrier(r);
        evaluateEndTurnBarrier(r);
        return;

      case "SET_CHAR":
        if (typeof msg.charClass === "string") player.charClass = msg.charClass.slice(0, 24);
        if (typeof msg.ready === "boolean") player.ready = msg.ready;
        if (typeof msg.name === "string" && msg.name.trim()) player.name = msg.name.trim().slice(0, 20);
        if (player.playerId === r.hostId && r.state === "LOBBY") {
          if (msg.mode === "RACE" || msg.mode === "COOP") r.mode = msg.mode;
          if (msg.ascension !== undefined) r.ascension = Math.max(0, Math.min(20, Number(msg.ascension) || 0));
          if (typeof msg.seedText === "string") r.seedText = msg.seedText.trim().slice(0, 24);
          if (typeof msg.seedLong === "string" && /^-?\d+$/.test(msg.seedLong)) r.seedLong = msg.seedLong;
        }
        broadcastRoom(r, buildRoomSyncPayload(r));
        return;

      case "START_RUN":
        if (player.playerId !== r.hostId) return;
        if (msg.mode === "RACE" || msg.mode === "COOP") r.mode = msg.mode;
        if (msg.ascension !== undefined) r.ascension = Math.max(0, Math.min(20, Number(msg.ascension) || 0));
        if (typeof msg.seedText === "string") r.seedText = msg.seedText.trim().slice(0, 24);
        if (typeof msg.seedLong === "string" && /^-?\d+$/.test(msg.seedLong)) r.seedLong = msg.seedLong;
        r.state = "IN_RUN";
        r.floorNum = 0;
        r.actNum = 1;
        r.turnNum = 1;
        r.nextSeq = 1;
        r.checkpoints.clear();
        r.combatActions = [];
        for (const p of r.players.values()) {
          p.ready = true;
          p.endTurnReady = false;
          p.isDowned = false;
          p.mapVoteX = -1;
          p.mapVoteY = -1;
          p.floorNum = 0;
        }
        broadcastRoom(r, { type: "START_RUN", mode: r.mode, ascension: r.ascension, seedText: r.seedText, seedLong: r.seedLong });
        broadcastRoom(r, buildRoomSyncPayload(r));
        return;

      case "PLAYER_STATE":
        player.hp = Number(msg.hp ?? player.hp);
        player.maxHp = Number(msg.maxHp ?? player.maxHp);
        player.block = Number(msg.block ?? 0);
        player.gold = Number(msg.gold ?? 0);
        player.energy = Number(msg.energy ?? 0);
        player.floorNum = Number(msg.floorNum ?? 0);
        player.isDowned = !!msg.isDowned;
        if (msg.actNum !== undefined && Number(msg.actNum) > r.actNum) r.actNum = Number(msg.actNum);
        broadcastRoom(r, { ...msg, slot: player.slot, playerId: player.playerId, name: player.name }, ws);
        return;

      case "FLOOR_CHECKPOINT": {
        const floorNum = Number(msg.floorNum ?? r.floorNum);
        if (msg.checkpoint) r.checkpoints.set(floorNum, msg.checkpoint);
        r.floorNum = floorNum;
        r.turnNum = 1;
        r.combatActions = [];
        return;
      }

      case "MAP_VOTE":
        player.mapVoteX = Number(msg.x ?? -1);
        player.mapVoteY = Number(msg.y ?? -1);
        broadcastRoom(r, { type: "MAP_VOTE_SYNC", slot: player.slot, x: player.mapVoteX, y: player.mapVoteY });
        evaluateMapBarrier(r);
        return;

      case "COMBAT_ACTION": {
        const seq = r.nextSeq++;
        const stamped = { ...msg, seq, sourceSlot: player.slot, sourcePlayerId: player.playerId };
        r.combatActions.push(stamped);
        broadcastRoom(r, stamped);
        return;
      }

      case "END_TURN_READY": {
        const ready = msg.ready !== false;
        if (ready && typeof msg.turnNum === "number" && msg.turnNum < r.turnNum) {
          ws.send(JSON.stringify({ type: "ALL_PLAYERS_END_TURN", turnNum: r.turnNum }));
          return;
        }
        player.endTurnReady = ready;
        broadcastRoom(r, { type: "END_TURN_STATUS", slot: player.slot, ready: player.endTurnReady });
        evaluateEndTurnBarrier(r);
        return;
      }

      case "PLAYER_DOWNED":
        player.isDowned = true;
        player.hp = 0;
        player.endTurnReady = true;
        broadcastRoom(r, { type: "PLAYER_DOWNED", slot: player.slot, name: player.name });
        broadcastRoom(r, buildRoomSyncPayload(r));
        evaluateWipeBarrier(r);
        evaluateEndTurnBarrier(r);
        return;

      case "PLAYER_REVIVE":
        if (typeof msg.targetSlot === "number" && msg.targetSlot >= 0) {
          for (const p of r.players.values()) if (p.slot === msg.targetSlot) { p.isDowned = false; p.endTurnReady = false; }
        } else {
          for (const p of r.players.values()) { p.isDowned = false; p.endTurnReady = false; }
        }
        broadcastRoom(r, { type: "PLAYER_REVIVED", targetSlot: msg.targetSlot ?? -1 });
        broadcastRoom(r, buildRoomSyncPayload(r));
        return;

      case "TRADE_OFFER":
      case "ALLY_BUFF": {
        const targetSlot = Number(msg.targetSlot);
        const delivered = JSON.stringify({
          ...msg,
          type: msg.type === "TRADE_OFFER" ? "TRADE_DELIVER" : "ALLY_BUFF",
          fromSlot: player.slot,
          fromName: player.name,
        });
        for (const s of r.sockets) {
          if (s._player && s._player.slot === targetSlot && s.readyState === WebSocket.OPEN) {
            try { s.send(delivered); } catch (_) {}
          }
        }
        return;
      }

      case "CARD_PLAYED_FX":
        broadcastRoom(r, { type: "CARD_PLAYED_FX", slot: player.slot, name: player.name, cardName: msg.cardName || "" }, ws);
        return;

      case "WEBRTC_SIGNAL": {
        const toSlot = Number(msg.toSlot);
        const pkt = JSON.stringify({ type: "WEBRTC_SIGNAL", fromSlot: player.slot, signal: msg.signal });
        for (const s of r.sockets) {
          if (s._player && s._player.slot === toSlot && s.readyState === WebSocket.OPEN) {
            try { s.send(pkt); } catch (_) {}
          }
        }
      }
    }
  });

  ws.on("close", () => {
    r.sockets.delete(ws);
    player.connected = false;
    if (r.state === "LOBBY" && r.hostId === player.playerId) {
      const nextHost = Array.from(r.players.values()).find((p) => p.connected);
      if (nextHost) r.hostId = nextHost.playerId;
    }
    broadcastRoom(r, buildRoomSyncPayload(r));
    evaluateMapBarrier(r);
    evaluateEndTurnBarrier(r);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[stsweb] Full-featured local server listening on http://127.0.0.1:${PORT} (HTTP + WS + SQLite)`);
});
