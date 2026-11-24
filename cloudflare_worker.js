// ============================================================================
// Slay the Spire Web — Cloudflare Worker + Hibernatable SQLite Durable Objects
// ============================================================================

import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS_PER_ROOM = 6;
const ROOM_INACTIVITY_TTL_MS = 60 * 1000; // Dissolve room after 1 min of no activity
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function normalizeRoomCode(raw) {
  const clean = String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  return clean.slice(0, 16) || "SPIRE";
}

function generateSeedLongString() {
  const arr = new Uint32Array(2);
  crypto.getRandomValues(arr);
  const hi = BigInt(arr[0] & 0x7fffffff);
  const lo = BigInt(arr[1]);
  const val = (hi << 32n) | lo;
  return (val === 0n ? 1337n : val).toString();
}

function randomHex(byteLen) {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: hexToBytes(saltHex),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
  const bytes = new Uint8Array(bits);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

// ============================================================================
// Global Lobby Directory + Accounts + 3-Slot Cloud Saves (SQLite DO)
// ============================================================================

export class StsLobbyHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
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
        CREATE TABLE IF NOT EXISTS saves (
          user_id INTEGER NOT NULL,
          slot INTEGER NOT NULL,
          label TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, slot)
        );
        CREATE TABLE IF NOT EXISTS account_saves (
          user_id INTEGER PRIMARY KEY,
          username TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS rooms (
          code TEXT PRIMARY KEY,
          host_name TEXT NOT NULL,
          mode TEXT NOT NULL,
          ascension INTEGER NOT NULL,
          player_count INTEGER NOT NULL,
          max_players INTEGER NOT NULL,
          state TEXT NOT NULL,
          floor_num INTEGER NOT NULL,
          act_num INTEGER NOT NULL,
          joinable INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    });
  }

  async upsertRoom(summary) {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO rooms (code, host_name, mode, ascension, player_count, max_players, state, floor_num, act_num, joinable, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         host_name = excluded.host_name,
         mode = excluded.mode,
         ascension = excluded.ascension,
         player_count = excluded.player_count,
         max_players = excluded.max_players,
         state = excluded.state,
         floor_num = excluded.floor_num,
         act_num = excluded.act_num,
         joinable = excluded.joinable,
         updated_at = excluded.updated_at`,
      summary.code,
      summary.hostName || "Player",
      summary.mode || "COOP",
      Number(summary.ascension || 0),
      Number(summary.playerCount || 1),
      Number(summary.maxPlayers || MAX_PLAYERS_PER_ROOM),
      summary.state || "LOBBY",
      Number(summary.floorNum || 0),
      Number(summary.actNum || 1),
      summary.joinable ? 1 : 0,
      now
    );
  }

  async removeRoom(code) {
    this.ctx.storage.sql.exec("DELETE FROM rooms WHERE code = ?", code);
  }

  getSessionUser(request) {
    const auth = request.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return null;
    const token = auth.slice(7).trim();
    if (!token) return null;
    const row = this.ctx.storage.sql
      .exec("SELECT user_id, username, expires_at FROM sessions WHERE token = ?", token)
      .toArray()[0];
    if (!row || row.expires_at < Date.now()) {
      if (row) this.ctx.storage.sql.exec("DELETE FROM sessions WHERE token = ?", token);
      return null;
    }
    return { userId: row.user_id, username: row.username };
  }

  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);

    if (url.pathname === "/api/rooms" && request.method === "GET") {
      const cutoff = Date.now() - ROOM_INACTIVITY_TTL_MS;
      this.ctx.storage.sql.exec("DELETE FROM rooms WHERE updated_at < ? OR player_count <= 0", cutoff);
      const rows = this.ctx.storage.sql
        .exec("SELECT code, host_name, mode, ascension, player_count, max_players, state, floor_num, act_num, joinable, updated_at FROM rooms ORDER BY updated_at DESC LIMIT 50")
        .toArray();
      return jsonResponse({ rooms: rows });
    }

    if (url.pathname === "/api/auth/register" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const username = String(body?.username || "").trim();
      const password = String(body?.password || "");
      if (!/^[A-Za-z0-9_.-]{3,24}$/.test(username) || password.length < 4) {
        return jsonResponse({ error: "Username must be 3-24 chars (letters/numbers/_.-) and password >= 4 chars." }, 400);
      }
      const existing = this.ctx.storage.sql.exec("SELECT id FROM accounts WHERE lower(username) = lower(?)", username).toArray();
      if (existing.length > 0) {
        return jsonResponse({ error: "Username already exists." }, 409);
      }
      const salt = randomHex(16);
      const passHash = await hashPassword(password, salt);
      const now = Date.now();
      const inserted = this.ctx.storage.sql
        .exec(
          "INSERT INTO accounts (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?) RETURNING id",
          username,
          passHash,
          salt,
          now
        )
        .one();
      const token = randomHex(32);
      this.ctx.storage.sql.exec(
        "INSERT INTO sessions (token, user_id, username, expires_at) VALUES (?, ?, ?, ?)",
        token,
        inserted.id,
        username,
        now + SESSION_TTL_MS
      );
      return jsonResponse({ token, username, hasSave: false, updated_at: null });
    }

    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const username = String(body?.username || "").trim();
      const password = String(body?.password || "");
      const acct = this.ctx.storage.sql
        .exec("SELECT id, username, pass_hash, salt FROM accounts WHERE lower(username) = lower(?)", username)
        .toArray()[0];
      if (!acct) {
        return jsonResponse({ error: "Invalid credentials." }, 401);
      }
      const calc = await hashPassword(password, acct.salt);
      if (!constantTimeEqual(calc, acct.pass_hash)) {
        return jsonResponse({ error: "Invalid credentials." }, 401);
      }
      const token = randomHex(32);
      this.ctx.storage.sql.exec(
        "INSERT INTO sessions (token, user_id, username, expires_at) VALUES (?, ?, ?, ?)",
        token,
        acct.id,
        acct.username,
        Date.now() + SESSION_TTL_MS
      );
      const acctSave = this.ctx.storage.sql
        .exec("SELECT updated_at FROM account_saves WHERE user_id = ?", acct.id)
        .toArray()[0];
      return jsonResponse({
        token,
        username: acct.username,
        hasSave: !!acctSave,
        updated_at: acctSave ? acctSave.updated_at : null,
      });
    }

    if (url.pathname === "/api/auth/me" && request.method === "GET") {
      const user = this.getSessionUser(request);
      if (!user) return jsonResponse({ error: "Unauthorized" }, 401);
      const acctSave = this.ctx.storage.sql
        .exec("SELECT length(payload_json) AS bytes, updated_at FROM account_saves WHERE user_id = ?", user.userId)
        .toArray()[0];
      return jsonResponse({
        username: user.username,
        hasSave: !!acctSave,
        saveBytes: acctSave ? acctSave.bytes : 0,
        updated_at: acctSave ? acctSave.updated_at : null,
      });
    }

    if (url.pathname === "/api/account/save") {
      const user = this.getSessionUser(request);
      if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

      if (request.method === "GET") {
        const row = this.ctx.storage.sql
          .exec("SELECT payload_json, updated_at FROM account_saves WHERE user_id = ?", user.userId)
          .toArray()[0];
        return jsonResponse({
          ok: true,
          username: user.username,
          hasSave: !!row,
          updated_at: row ? row.updated_at : null,
          payload: row ? JSON.parse(row.payload_json) : null,
        });
      }

      if (request.method === "PUT" || request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body || !body.payload || typeof body.payload !== "object") {
          return jsonResponse({ error: "Invalid save payload" }, 400);
        }
        const payloadStr = JSON.stringify(body.payload);
        if (payloadStr.length > 2 * 1024 * 1024) {
          return jsonResponse({ error: "Save bundle exceeds 2 MiB limit" }, 413);
        }
        const now = Date.now();
        this.ctx.storage.sql.exec(
          `INSERT INTO account_saves (user_id, username, payload_json, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             username = excluded.username,
             payload_json = excluded.payload_json,
             updated_at = excluded.updated_at`,
          user.userId,
          user.username,
          payloadStr,
          now
        );
        return jsonResponse({ ok: true, username: user.username, bytes: payloadStr.length, updated_at: now });
      }
    }

    if (url.pathname === "/api/saves" && request.method === "GET") {
      const user = this.getSessionUser(request);
      if (!user) return jsonResponse({ error: "Unauthorized" }, 401);
      const rows = this.ctx.storage.sql
        .exec("SELECT slot, label, length(payload_json) AS bytes, updated_at FROM saves WHERE user_id = ? ORDER BY slot ASC", user.userId)
        .toArray();
      return jsonResponse({ username: user.username, slots: rows });
    }

    const slotMatch = url.pathname.match(/^\/api\/saves\/([1-3])$/);
    if (slotMatch) {
      const user = this.getSessionUser(request);
      if (!user) return jsonResponse({ error: "Unauthorized" }, 401);
      const slot = parseInt(slotMatch[1], 10);

      if (request.method === "GET") {
        const row = this.ctx.storage.sql
          .exec("SELECT slot, label, payload_json, updated_at FROM saves WHERE user_id = ? AND slot = ?", user.userId, slot)
          .toArray()[0];
        if (!row) return jsonResponse({ error: "Save slot empty" }, 404);
        return jsonResponse({
          slot: row.slot,
          label: row.label,
          updated_at: row.updated_at,
          payload: JSON.parse(row.payload_json),
        });
      }

      if (request.method === "PUT") {
        const body = await request.json().catch(() => null);
        if (!body || !body.payload || typeof body.payload !== "object") {
          return jsonResponse({ error: "Invalid save payload" }, 400);
        }
        const payloadStr = JSON.stringify(body.payload);
        if (payloadStr.length > 2 * 1024 * 1024) {
          return jsonResponse({ error: "Save bundle exceeds 2 MiB limit" }, 413);
        }
        const label = String(body.label || `Cloud Slot ${slot}`).slice(0, 48);
        const now = Date.now();
        this.ctx.storage.sql.exec(
          `INSERT INTO saves (user_id, slot, label, payload_json, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, slot) DO UPDATE SET
             label = excluded.label,
             payload_json = excluded.payload_json,
             updated_at = excluded.updated_at`,
          user.userId,
          slot,
          label,
          payloadStr,
          now
        );
        return jsonResponse({ ok: true, slot, label, bytes: payloadStr.length, updated_at: now });
      }
    }

    return jsonResponse({ error: "Not found" }, 404);
  }
}

// ============================================================================
// Per-Room Authoritative Co-op & Race Coordinator (Hibernatable SQLite DO)
// ============================================================================

export class StsRoomDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          code TEXT NOT NULL,
          host_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          seed_text TEXT NOT NULL,
          seed_long TEXT NOT NULL,
          ascension INTEGER NOT NULL,
          state TEXT NOT NULL,
          floor_num INTEGER NOT NULL,
          act_num INTEGER NOT NULL,
          turn_num INTEGER NOT NULL,
          next_seq INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS players (
          player_id TEXT PRIMARY KEY,
          slot INTEGER UNIQUE NOT NULL,
          name TEXT NOT NULL,
          char_class TEXT NOT NULL,
          hp INTEGER NOT NULL,
          max_hp INTEGER NOT NULL,
          block INTEGER NOT NULL,
          gold INTEGER NOT NULL,
          energy INTEGER NOT NULL,
          ready INTEGER NOT NULL,
          end_turn_ready INTEGER NOT NULL,
          is_downed INTEGER NOT NULL,
          map_vote_x INTEGER NOT NULL,
          map_vote_y INTEGER NOT NULL,
          floor_num INTEGER NOT NULL,
          connected INTEGER NOT NULL,
          last_seen INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS checkpoints (
          floor_num INTEGER PRIMARY KEY,
          checkpoint_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS combat_actions (
          seq INTEGER PRIMARY KEY,
          floor_num INTEGER NOT NULL,
          turn_num INTEGER NOT NULL,
          msg_json TEXT NOT NULL
        );
      `);
    });
  }

  getMeta() {
    return this.ctx.storage.sql.exec("SELECT * FROM room_meta WHERE id = 1").toArray()[0] || null;
  }

  ensureMeta(code, hostId, mode, ascension, seedText) {
    const existing = this.getMeta();
    if (existing) return existing;
    const now = Date.now();
    const cleanMode = mode === "RACE" ? "RACE" : "COOP";
    const seedLong = generateSeedLongString();
    this.ctx.storage.sql.exec(
      `INSERT INTO room_meta (id, code, host_id, mode, seed_text, seed_long, ascension, state, floor_num, act_num, turn_num, next_seq, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, 'LOBBY', 0, 1, 1, 1, ?)`,
      code,
      hostId,
      cleanMode,
      seedText || "",
      seedLong,
      Math.max(0, Math.min(20, Number(ascension || 0))),
      now
    );
    return this.getMeta();
  }

  listPlayers() {
    return this.ctx.storage.sql.exec("SELECT * FROM players ORDER BY slot ASC").toArray();
  }

  buildRoomSyncPayload() {
    const meta = this.getMeta();
    const players = this.listPlayers();
    return {
      type: "ROOM_SYNC",
      room: meta
        ? {
            code: meta.code,
            hostId: meta.host_id,
            mode: meta.mode,
            seedText: meta.seed_text,
            seedLong: meta.seed_long,
            ascension: meta.ascension,
            state: meta.state,
            floorNum: meta.floor_num,
            actNum: meta.act_num,
            turnNum: meta.turn_num,
            nextSeq: meta.next_seq,
          }
        : null,
      players: players.map((p) => ({
        playerId: p.player_id,
        slot: p.slot,
        name: p.name,
        charClass: p.char_class,
        hp: p.hp,
        maxHp: p.max_hp,
        block: p.block,
        gold: p.gold,
        energy: p.energy,
        ready: p.ready === 1,
        endTurnReady: p.end_turn_ready === 1,
        isDowned: p.is_downed === 1,
        mapVoteX: p.map_vote_x,
        mapVoteY: p.map_vote_y,
        floorNum: p.floor_num,
        connected: p.connected === 1,
      })),
    };
  }

  broadcast(obj, excludeWs = null) {
    const str = typeof obj === "string" ? obj : JSON.stringify(obj);
    for (const sock of this.ctx.getWebSockets()) {
      if (excludeWs && sock === excludeWs) continue;
      try {
        sock.send(str);
      } catch (_) {}
    }
  }

  reconcileConnectedPlayers(excludeWs = null) {
    const meta = this.getMeta();
    const liveIds = new Set();
    for (const sock of this.ctx.getWebSockets()) {
      if (sock === excludeWs) continue;
      if (typeof sock.readyState === "number" && sock.readyState !== 1) continue;
      const att = sock.deserializeAttachment();
      if (att && att.playerId) liveIds.add(att.playerId);
    }
    const players = this.listPlayers();
    for (const p of players) {
      const shouldBeConn = liveIds.has(p.player_id) ? 1 : 0;
      if (p.connected !== shouldBeConn) {
        this.ctx.storage.sql.exec("UPDATE players SET connected = ? WHERE player_id = ?", shouldBeConn, p.player_id);
        p.connected = shouldBeConn;
      }
    }
    const connectedPlayers = players.filter((p) => p.connected === 1);
    return { meta, players, connectedPlayers };
  }

  syncLobbyHub(force = true, excludeWs = null) {
    const { meta, players, connectedPlayers } = this.reconcileConnectedPlayers(excludeWs);
    const hub = this.env.LOBBY_HUB.get(this.env.LOBBY_HUB.idFromName("global-sts-hub"));
    if (!meta || connectedPlayers.length === 0 || meta.state === "ENDED") {
      if (meta) {
        const p = hub.removeRoom(meta.code);
        this.ctx.waitUntil(p);
        return p;
      }
      return Promise.resolve();
    }
    const now = Date.now();
    if (!force && this._lastHubSyncAt && now - this._lastHubSyncAt < 20000) {
      return Promise.resolve();
    }
    this._lastHubSyncAt = now;
    const host = connectedPlayers.find((p) => p.player_id === meta.host_id) || connectedPlayers[0] || players[0];
    const p = hub.upsertRoom({
      code: meta.code,
      hostName: host ? host.name : "Player",
      mode: meta.mode,
      ascension: meta.ascension,
      playerCount: connectedPlayers.length,
      maxPlayers: MAX_PLAYERS_PER_ROOM,
      state: meta.state,
      floorNum: meta.floor_num,
      actNum: meta.act_num,
      joinable: connectedPlayers.length < MAX_PLAYERS_PER_ROOM,
    });
    this.ctx.waitUntil(p);
    return p;
  }

  touchRoomActivity(now = Date.now(), forceHubSync = false) {
    this.ctx.storage.sql.exec("UPDATE room_meta SET updated_at = ? WHERE id = 1", now);
    this.scheduleCleanupAlarm(now);
    this.syncLobbyHub(forceHubSync);
  }

  scheduleCleanupAlarm(now = Date.now()) {
    this.ctx.waitUntil(this.ctx.storage.setAlarm(now + ROOM_INACTIVITY_TTL_MS));
  }

  evaluateMapBarrier() {
    const meta = this.getMeta();
    if (!meta || meta.state !== "IN_RUN" || meta.mode !== "COOP") return;
    const voters = this.ctx.storage.sql
      .exec("SELECT slot, map_vote_x, map_vote_y FROM players WHERE connected = 1 AND is_downed = 0 ORDER BY slot ASC")
      .toArray();
    if (voters.length === 0) return;
    if (voters.some((p) => p.map_vote_x < 0 || p.map_vote_y < 0)) return;

    const counts = new Map();
    for (const v of voters) {
      const key = `${v.map_vote_x}:${v.map_vote_y}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let bestKey = `${voters[0].map_vote_x}:${voters[0].map_vote_y}`;
    let bestCount = -1;
    for (const [k, c] of counts.entries()) {
      if (c > bestCount) {
        bestCount = c;
        bestKey = k;
      }
    }
    const [winX, winY] = bestKey.split(":").map((n) => parseInt(n, 10));
    const nextFloor = meta.floor_num + 1;
    this.ctx.storage.sql.exec("UPDATE players SET map_vote_x = -1, map_vote_y = -1, end_turn_ready = 0");
    this.ctx.storage.sql.exec("UPDATE room_meta SET floor_num = ?, turn_num = 1, updated_at = ? WHERE id = 1", nextFloor, Date.now());
    this.ctx.storage.sql.exec("DELETE FROM combat_actions WHERE floor_num < ?", nextFloor);
    this.broadcast({ type: "MAP_ADVANCE", x: winX, y: winY, floorNum: nextFloor });
    this.broadcast(this.buildRoomSyncPayload());
    this.syncLobbyHub(true);
    this.scheduleCleanupAlarm();
  }

  evaluateEndTurnBarrier() {
    const meta = this.getMeta();
    if (!meta || meta.state !== "IN_RUN" || meta.mode !== "COOP") return;
    const living = this.ctx.storage.sql
      .exec("SELECT slot, end_turn_ready FROM players WHERE connected = 1 AND is_downed = 0 ORDER BY slot ASC")
      .toArray();
    if (living.length === 0) return;
    if (living.some((p) => p.end_turn_ready === 0)) return;

    const nextTurn = meta.turn_num + 1;
    this.ctx.storage.sql.exec("UPDATE players SET end_turn_ready = 0");
    this.ctx.storage.sql.exec("UPDATE room_meta SET turn_num = ?, updated_at = ? WHERE id = 1", nextTurn, Date.now());
    this.broadcast({ type: "ALL_PLAYERS_END_TURN", turnNum: nextTurn });
    this.broadcast(this.buildRoomSyncPayload());
  }

  evaluateWipeBarrier() {
    const meta = this.getMeta();
    if (!meta || meta.state !== "IN_RUN" || meta.mode !== "COOP") return;
    const alive = this.ctx.storage.sql
      .exec("SELECT COUNT(*) AS cnt FROM players WHERE connected = 1 AND is_downed = 0")
      .one();
    if (alive.cnt === 0) {
      this.ctx.storage.sql.exec("UPDATE room_meta SET state = 'ENDED', updated_at = ? WHERE id = 1", Date.now());
      this.broadcast({ type: "ALL_PLAYERS_WIPED" });
      this.syncLobbyHub();
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const code = normalizeRoomCode(url.searchParams.get("room"));

    if (url.pathname.startsWith("/api/room/")) {
      return jsonResponse(this.buildRoomSyncPayload());
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "Expected WebSocket upgrade" }, 400);
    }

    const playerId = String(url.searchParams.get("playerId") || "").trim() || crypto.randomUUID();
    const name = String(url.searchParams.get("name") || "Player").trim().slice(0, 20) || "Player";
    const charClass = String(url.searchParams.get("charClass") || "IRONCLAD").trim();
    const mode = String(url.searchParams.get("mode") || "COOP").trim().toUpperCase();
    const ascension = parseInt(url.searchParams.get("ascension") || "0", 10) || 0;
    const seedText = String(url.searchParams.get("seed") || "").trim();

    const meta = this.ensureMeta(code, playerId, mode, ascension, seedText);
    const existingPlayers = this.listPlayers();
    let player = existingPlayers.find((p) => p.player_id === playerId);
    const now = Date.now();

    if (!player) {
      if (existingPlayers.length >= MAX_PLAYERS_PER_ROOM) {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.accept();
        server.send(JSON.stringify({ type: "ERROR", message: "Room is full (6/6 players)." }));
        server.close(4003, "Room full");
        return new Response(null, { status: 101, webSocket: client });
      }
      const usedSlots = new Set(existingPlayers.map((p) => p.slot));
      let freeSlot = 0;
      while (usedSlots.has(freeSlot) && freeSlot < MAX_PLAYERS_PER_ROOM) freeSlot++;
      this.ctx.storage.sql.exec(
        `INSERT INTO players (player_id, slot, name, char_class, hp, max_hp, block, gold, energy, ready, end_turn_ready, is_downed, map_vote_x, map_vote_y, floor_num, connected, last_seen)
         VALUES (?, ?, ?, ?, 80, 80, 0, 99, 3, 0, 0, 0, -1, -1, 0, 1, ?)`,
        playerId,
        freeSlot,
        name,
        charClass,
        now
      );
      player = this.ctx.storage.sql.exec("SELECT * FROM players WHERE player_id = ?", playerId).one();
    } else {
      this.ctx.storage.sql.exec(
        "UPDATE players SET name = ?, connected = 1, last_seen = ? WHERE player_id = ?",
        name,
        now,
        playerId
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId, slot: player.slot, name });

    // Send Welcome + Room Sync + Checkpoint/Actions replay on rejoin
    server.send(JSON.stringify({ type: "WELCOME", playerId, slot: player.slot, roomCode: meta.code }));
    const syncPayload = this.buildRoomSyncPayload();
    server.send(JSON.stringify(syncPayload));

    if (meta.state === "IN_RUN") {
      const latestCp = this.ctx.storage.sql
        .exec("SELECT floor_num, checkpoint_json FROM checkpoints ORDER BY floor_num DESC LIMIT 1")
        .toArray()[0];
      const actions = this.ctx.storage.sql
        .exec("SELECT seq, msg_json FROM combat_actions WHERE floor_num = ? ORDER BY seq ASC", meta.floor_num)
        .toArray();
      if (latestCp || actions.length > 0) {
        server.send(
          JSON.stringify({
            type: "CHECKPOINT_RESTORE",
            floorNum: latestCp ? latestCp.floor_num : meta.floor_num,
            checkpoint: latestCp ? JSON.parse(latestCp.checkpoint_json) : null,
            actions: actions.map((a) => JSON.parse(a.msg_json)),
          })
        );
      }
    }

    this.broadcast(syncPayload, server);
    this.evaluateEndTurnBarrier();
    this.touchRoomActivity(now, true);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, rawMessage) {
    const att = ws.deserializeAttachment();
    if (!att) return;
    let msg;
    try {
      msg = JSON.parse(typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage));
    } catch (_) {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;

    const meta = this.getMeta();
    if (!meta) return;
    const now = Date.now();
    this.ctx.storage.sql.exec("UPDATE players SET last_seen = ? WHERE player_id = ?", now, att.playerId);

    switch (msg.type) {
      case "PING": {
        this.touchRoomActivity(now, false);
        ws.send(JSON.stringify({ type: "PONG", ts: now }));
        return;
      }

      case "LEAVE_ROOM": {
        this.ctx.storage.sql.exec("UPDATE players SET connected = 0, last_seen = ? WHERE player_id = ?", now, att.playerId);
        if (meta.state === "LOBBY" && meta.host_id === att.playerId) {
          const nextHost = this.ctx.storage.sql
            .exec("SELECT player_id FROM players WHERE connected = 1 AND player_id != ? ORDER BY slot ASC LIMIT 1", att.playerId)
            .toArray()[0];
          if (nextHost) {
            this.ctx.storage.sql.exec("UPDATE room_meta SET host_id = ? WHERE id = 1", nextHost.player_id);
          }
        }
        try {
          ws.close(1000, "Leave room");
        } catch (_) {}
        this.broadcast(this.buildRoomSyncPayload(), ws);
        this.evaluateMapBarrier();
        this.evaluateEndTurnBarrier();
        await this.syncLobbyHub(true, ws);
        this.scheduleCleanupAlarm(now);
        return;
      }

      case "SET_CHAR": {
        if (typeof msg.charClass === "string") {
          this.ctx.storage.sql.exec("UPDATE players SET char_class = ? WHERE player_id = ?", msg.charClass.slice(0, 24), att.playerId);
        }
        if (typeof msg.ready === "boolean") {
          this.ctx.storage.sql.exec("UPDATE players SET ready = ? WHERE player_id = ?", msg.ready ? 1 : 0, att.playerId);
        }
        if (typeof msg.name === "string" && msg.name.trim()) {
          const cleanName = msg.name.trim().slice(0, 20);
          this.ctx.storage.sql.exec("UPDATE players SET name = ? WHERE player_id = ?", cleanName, att.playerId);
          ws.serializeAttachment({ ...att, name: cleanName });
        }
        if (att.playerId === meta.host_id && meta.state === "LOBBY") {
          const nextMode = msg.mode === "RACE" ? "RACE" : (msg.mode === "COOP" ? "COOP" : meta.mode);
          const nextAsc = msg.ascension !== undefined ? Math.max(0, Math.min(20, Number(msg.ascension) || 0)) : meta.ascension;
          const nextSeedText = typeof msg.seedText === "string" ? msg.seedText.trim().slice(0, 24) : meta.seed_text;
          const nextSeedLong = typeof msg.seedLong === "string" && /^-?\d+$/.test(msg.seedLong) ? msg.seedLong : meta.seed_long;
          this.ctx.storage.sql.exec(
            "UPDATE room_meta SET mode = ?, ascension = ?, seed_text = ?, seed_long = ?, updated_at = ? WHERE id = 1",
            nextMode, nextAsc, nextSeedText, nextSeedLong, now
          );
        }
        this.broadcast(this.buildRoomSyncPayload());
        this.touchRoomActivity(now, true);
        return;
      }

      case "START_RUN": {
        if (att.playerId !== meta.host_id) return;
        const seedLong = typeof msg.seedLong === "string" && /^-?\d+$/.test(msg.seedLong)
          ? msg.seedLong
          : (meta.seed_long || generateSeedLongString());
        const seedText = typeof msg.seedText === "string" ? msg.seedText.trim().slice(0, 24) : meta.seed_text;
        const ascension = msg.ascension !== undefined ? Math.max(0, Math.min(20, Number(msg.ascension) || 0)) : meta.ascension;
        const mode = msg.mode === "RACE" ? "RACE" : (msg.mode === "COOP" ? "COOP" : meta.mode);

        this.ctx.storage.sql.exec("DELETE FROM checkpoints");
        this.ctx.storage.sql.exec("DELETE FROM combat_actions");
        this.ctx.storage.sql.exec(
          "UPDATE players SET ready = 1, end_turn_ready = 0, is_downed = 0, map_vote_x = -1, map_vote_y = -1, floor_num = 0"
        );
        this.ctx.storage.sql.exec(
          "UPDATE room_meta SET mode = ?, ascension = ?, seed_text = ?, seed_long = ?, state = 'IN_RUN', floor_num = 0, act_num = 1, turn_num = 1, next_seq = 1, updated_at = ? WHERE id = 1",
          mode, ascension, seedText, seedLong, now
        );
        this.broadcast({
          type: "START_RUN",
          mode,
          ascension,
          seedText,
          seedLong,
        });
        this.broadcast(this.buildRoomSyncPayload());
        this.syncLobbyHub(true);
        this.scheduleCleanupAlarm(now);
        return;
      }

      case "PLAYER_STATE": {
        this.ctx.storage.sql.exec(
          `UPDATE players SET
             hp = ?, max_hp = ?, block = ?, gold = ?, energy = ?,
             floor_num = ?, is_downed = ?
           WHERE player_id = ?`,
          Number(msg.hp ?? 0),
          Number(msg.maxHp ?? 80),
          Number(msg.block ?? 0),
          Number(msg.gold ?? 0),
          Number(msg.energy ?? 0),
          Number(msg.floorNum ?? 0),
          msg.isDowned ? 1 : 0,
          att.playerId
        );
        if (msg.actNum !== undefined && Number(msg.actNum) > meta.act_num) {
          this.ctx.storage.sql.exec("UPDATE room_meta SET act_num = ?, updated_at = ? WHERE id = 1", Number(msg.actNum), now);
        }
        this.broadcast({ ...msg, slot: att.slot, playerId: att.playerId, name: att.name }, ws);
        this.touchRoomActivity(now, false);
        return;
      }

      case "FLOOR_CHECKPOINT": {
        const floorNum = Number(msg.floorNum ?? meta.floor_num);
        if (msg.checkpoint) {
          this.ctx.storage.sql.exec(
            `INSERT INTO checkpoints (floor_num, checkpoint_json, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(floor_num) DO UPDATE SET checkpoint_json = excluded.checkpoint_json, updated_at = excluded.updated_at`,
            floorNum,
            JSON.stringify(msg.checkpoint),
            now
          );
        }
        this.ctx.storage.sql.exec("UPDATE room_meta SET floor_num = ?, turn_num = 1, updated_at = ? WHERE id = 1", floorNum, now);
        this.ctx.storage.sql.exec("DELETE FROM combat_actions WHERE floor_num < ?", floorNum);
        this.scheduleCleanupAlarm(now);
        this.syncLobbyHub(false);
        return;
      }

      case "MAP_VOTE": {
        this.ctx.storage.sql.exec(
          "UPDATE players SET map_vote_x = ?, map_vote_y = ? WHERE player_id = ?",
          Number(msg.x ?? -1),
          Number(msg.y ?? -1),
          att.playerId
        );
        this.broadcast({ type: "MAP_VOTE_SYNC", slot: att.slot, x: Number(msg.x ?? -1), y: Number(msg.y ?? -1) });
        this.touchRoomActivity(now, false);
        this.evaluateMapBarrier();
        return;
      }

      case "COMBAT_ACTION": {
        const seq = meta.next_seq;
        this.ctx.storage.sql.exec("UPDATE room_meta SET next_seq = ?, updated_at = ? WHERE id = 1", seq + 1, now);
        const stamped = { ...msg, seq, sourceSlot: att.slot, sourcePlayerId: att.playerId };
        const stampedJson = JSON.stringify(stamped);
        this.ctx.storage.sql.exec(
          "INSERT INTO combat_actions (seq, floor_num, turn_num, msg_json) VALUES (?, ?, ?, ?)",
          seq,
          meta.floor_num,
          meta.turn_num,
          stampedJson
        );
        this.broadcast(stampedJson);
        this.scheduleCleanupAlarm(now);
        this.syncLobbyHub(false);
        return;
      }

      case "END_TURN_READY": {
        const ready = msg.ready !== false;
        if (ready && typeof msg.turnNum === "number" && msg.turnNum < meta.turn_num) {
          ws.send(JSON.stringify({ type: "ALL_PLAYERS_END_TURN", turnNum: meta.turn_num }));
          return;
        }
        this.ctx.storage.sql.exec("UPDATE players SET end_turn_ready = ? WHERE player_id = ?", ready ? 1 : 0, att.playerId);
        this.broadcast({ type: "END_TURN_STATUS", slot: att.slot, ready });
        this.touchRoomActivity(now, false);
        this.evaluateEndTurnBarrier();
        return;
      }

      case "PLAYER_DOWNED": {
        this.ctx.storage.sql.exec("UPDATE players SET is_downed = 1, hp = 0, end_turn_ready = 1 WHERE player_id = ?", att.playerId);
        this.broadcast({ type: "PLAYER_DOWNED", slot: att.slot, name: att.name });
        this.broadcast(this.buildRoomSyncPayload());
        this.touchRoomActivity(now, true);
        this.evaluateWipeBarrier();
        this.evaluateEndTurnBarrier();
        return;
      }

      case "PLAYER_REVIVE": {
        if (typeof msg.targetSlot === "number") {
          this.ctx.storage.sql.exec("UPDATE players SET is_downed = 0, end_turn_ready = 0 WHERE slot = ?", msg.targetSlot);
        } else {
          this.ctx.storage.sql.exec("UPDATE players SET is_downed = 0, end_turn_ready = 0");
        }
        this.broadcast({ type: "PLAYER_REVIVED", targetSlot: msg.targetSlot ?? -1 });
        this.broadcast(this.buildRoomSyncPayload());
        this.touchRoomActivity(now, true);
        return;
      }

      case "TRADE_OFFER":
      case "ALLY_BUFF": {
        const targetSlot = Number(msg.targetSlot);
        const delivered = JSON.stringify({
          ...msg,
          type: msg.type === "TRADE_OFFER" ? "TRADE_DELIVER" : "ALLY_BUFF",
          fromSlot: att.slot,
          fromName: att.name,
        });
        for (const sock of this.ctx.getWebSockets()) {
          const peerAtt = sock.deserializeAttachment();
          if (peerAtt && peerAtt.slot === targetSlot) {
            try { sock.send(delivered); } catch (_) {}
          }
        }
        this.touchRoomActivity(now, false);
        return;
      }

      case "CARD_PLAYED_FX": {
        this.broadcast({ type: "CARD_PLAYED_FX", slot: att.slot, name: att.name, cardName: msg.cardName || "" }, ws);
        this.touchRoomActivity(now, false);
        return;
      }

      case "WEBRTC_SIGNAL": {
        const toSlot = Number(msg.toSlot);
        const pkt = JSON.stringify({ type: "WEBRTC_SIGNAL", fromSlot: att.slot, signal: msg.signal });
        for (const sock of this.ctx.getWebSockets()) {
          const peerAtt = sock.deserializeAttachment();
          if (peerAtt && peerAtt.slot === toSlot) {
            try { sock.send(pkt); } catch (_) {}
          }
        }
      }
    }
  }

  async webSocketClose(ws, code, reason) {
    const att = ws.deserializeAttachment();
    try {
      ws.close(code || 1000, reason || "Closed");
    } catch (_) {}
    if (!att) return;
    const meta = this.getMeta();
    if (!meta) return;

    this.ctx.storage.sql.exec("UPDATE players SET connected = 0, last_seen = ? WHERE player_id = ?", Date.now(), att.playerId);

    if (meta.state === "LOBBY" && meta.host_id === att.playerId) {
      const nextHost = this.ctx.storage.sql
        .exec("SELECT player_id FROM players WHERE connected = 1 AND player_id != ? ORDER BY slot ASC LIMIT 1", att.playerId)
        .toArray()[0];
      if (nextHost) {
        this.ctx.storage.sql.exec("UPDATE room_meta SET host_id = ? WHERE id = 1", nextHost.player_id);
      }
    }

    this.broadcast(this.buildRoomSyncPayload(), ws);
    this.evaluateMapBarrier();
    this.evaluateEndTurnBarrier();
    await this.syncLobbyHub(true, ws);
    this.scheduleCleanupAlarm();
  }

  async webSocketError(ws, err) {
    console.error("StsRoomDO WebSocket error:", err);
  }

  async alarm() {
    const meta = this.getMeta();
    if (!meta) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const now = Date.now();
    const sockets = this.ctx.getWebSockets();
    const idleMs = now - Number(meta.updated_at || 0);

    if (sockets.length === 0 || idleMs >= ROOM_INACTIVITY_TTL_MS - 1000) {
      for (const sock of sockets) {
        try {
          sock.send(JSON.stringify({ type: "ERROR", message: "Room dissolved after 1 minute of inactivity." }));
          sock.close(4000, "Room dissolved due to inactivity");
        } catch (_) {}
      }
      const hub = this.env.LOBBY_HUB.get(this.env.LOBBY_HUB.idFromName("global-sts-hub"));
      await hub.removeRoom(meta.code);
      await this.ctx.storage.deleteAll();
      return;
    }

    await this.ctx.storage.setAlarm(Number(meta.updated_at) + ROOM_INACTIVITY_TTL_MS);
  }
}

// ============================================================================
// Worker Fetch Entrypoint
// ============================================================================

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/time") {
      return jsonResponse({ epochSeconds: Math.floor(Date.now() / 1000) });
    }

    if (url.pathname === "/ws" || url.pathname.startsWith("/api/room/")) {
      const rawRoom = url.pathname.startsWith("/api/room/")
        ? url.pathname.slice("/api/room/".length)
        : url.searchParams.get("room");
      const code = normalizeRoomCode(rawRoom);
      const id = env.ROOM_DO.idFromName(`room:${code}`);
      const stub = env.ROOM_DO.get(id);
      return stub.fetch(request);
    }

    if (url.pathname.startsWith("/api/")) {
      const hubId = env.LOBBY_HUB.idFromName("global-sts-hub");
      const stub = env.LOBBY_HUB.get(hubId);
      return stub.fetch(request);
    }

    const assetResp = await env.ASSETS.fetch(request);
    if (
      assetResp.ok &&
      (url.pathname.endsWith(".bin") ||
        url.pathname.endsWith(".wasm") ||
        url.pathname.endsWith(".ogg"))
    ) {
      const headers = new Headers(assetResp.headers);
      headers.set("Cache-Control", "public, max-age=604800, immutable");
      if (url.pathname.endsWith(".bin")) {
        headers.set("Content-Type", "application/octet-stream");
      }
      return new Response(assetResp.body, {
        status: assetResp.status,
        statusText: assetResp.statusText,
        headers,
      });
    }
    return assetResp;
  },
};
