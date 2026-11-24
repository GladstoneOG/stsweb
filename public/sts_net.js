// ============================================================================
// Slay the Spire Web — Multiplayer Net Bridge (DO Hibernating WS + WebRTC)
// ============================================================================
(function () {
  const URL_PARAMS = new URLSearchParams(window.location.search || "");
  const PROFILE_TAG = (URL_PARAMS.get("profile") || "").replace(/[^A-Za-z0-9_-]/g, "");
  const TAB_ID_KEY = "stsweb_tab_player_id_v1" + (PROFILE_TAG ? "_" + PROFILE_TAG : "");
  const PLAYER_NAME_KEY = "stsweb_player_name_v1" + (PROFILE_TAG ? "_" + PROFILE_TAG : "");
  const WEBRTC_ENABLED_KEY = "stsweb_webrtc_enabled_v1";

  function getOrCreatePlayerId() {
    // Store per-tab playerId in sessionStorage so multiple browser tabs on one
    // machine can join the same Co-op room cleanly as distinct players while
    // preserving identity across page refreshes within each tab.
    let id = null;
    try {
      id = sessionStorage.getItem(TAB_ID_KEY);
      if (!id) {
        id = crypto.randomUUID
          ? crypto.randomUUID()
          : String(Date.now()) + Math.random().toString(16).slice(2);
        sessionStorage.setItem(TAB_ID_KEY, id);
      }
    } catch (_) {
      id = String(Date.now()) + Math.random().toString(16).slice(2);
    }
    return id;
  }

  function getSavedName() {
    return localStorage.getItem(PLAYER_NAME_KEY) || "SpirePlayer";
  }

  function generateRoomCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const arr = new Uint8Array(5);
    crypto.getRandomValues(arr);
    let out = "";
    for (let i = 0; i < arr.length; i++) out += alphabet[arr[i] % alphabet.length];
    return out;
  }

  let ws = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let manualClose = false;
  let lastConnectOpts = null;
  let lastActivityAt = Date.now();

  const bumpActivity = () => {
    lastActivityAt = Date.now();
  };
  if (typeof window !== "undefined") {
    for (const evt of ["pointerdown", "keydown", "wheel", "touchstart"]) {
      window.addEventListener(evt, bumpActivity, { passive: true, capture: true });
    }
  }

  const incomingQueue = [];
  const previewQueue = [];
  const rtcPeers = new Map(); // slot -> { pc, dc }
  const subscribers = new Set();

  const state = {
    connected: false,
    connecting: false,
    roomCode: "",
    playerId: getOrCreatePlayerId(),
    playerName: getSavedName(),
    slot: -1,
    hostId: "",
    isHost: false,
    mode: "COOP",
    ascension: 0,
    seedText: "",
    seedLong: "",
    runState: "LOBBY",
    floorNum: 0,
    actNum: 1,
    players: [],
    error: "",
    webrtcEnabled: localStorage.getItem(WEBRTC_ENABLED_KEY) !== "false",
  };

  function notify() {
    const snap = getState();
    for (const fn of subscribers) {
      try { fn(snap); } catch (_) {}
    }
  }

  function getRelayHttpBase() {
    return (window.STS_DEFAULT_RELAY || window.location.origin).replace(/\/+$/, "");
  }

  function getRelayWsBase() {
    return getRelayHttpBase().replace(/^http/i, "ws");
  }

  function closeAllRtc() {
    for (const entry of rtcPeers.values()) {
      try { entry.dc && entry.dc.close(); } catch (_) {}
      try { entry.pc && entry.pc.close(); } catch (_) {}
    }
    rtcPeers.clear();
  }

  function setupDataChannel(remoteSlot, dc) {
    dc.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        previewQueue.push(ev.data);
      }
    };
    dc.onopen = () => notify();
    dc.onclose = () => {
      const cur = rtcPeers.get(remoteSlot);
      if (cur && cur.dc === dc) rtcPeers.delete(remoteSlot);
      notify();
    };
  }

  function ensureRtcPeer(remoteSlot, initiator) {
    if (!state.webrtcEnabled || typeof RTCPeerConnection === "undefined") return null;
    if (remoteSlot === state.slot || remoteSlot < 0) return null;
    if (rtcPeers.has(remoteSlot)) return rtcPeers.get(remoteSlot);

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    const entry = { pc, dc: null };
    rtcPeers.set(remoteSlot, entry);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        send(JSON.stringify({
          type: "WEBRTC_SIGNAL",
          toSlot: remoteSlot,
          signal: { candidate: ev.candidate },
        }));
      }
    };

    pc.ondatachannel = (ev) => {
      entry.dc = ev.channel;
      setupDataChannel(remoteSlot, ev.channel);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        rtcPeers.delete(remoteSlot);
        notify();
      }
    };

    if (initiator) {
      const dc = pc.createDataChannel("sts-preview", { ordered: false, maxRetransmits: 0 });
      entry.dc = dc;
      setupDataChannel(remoteSlot, dc);
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer).then(() => offer))
        .then((offer) => {
          send(JSON.stringify({
            type: "WEBRTC_SIGNAL",
            toSlot: remoteSlot,
            signal: { sdp: offer },
          }));
        })
        .catch(() => {});
    }
    return entry;
  }

  async function handleRtcSignal(fromSlot, signal) {
    if (!state.webrtcEnabled || !signal) return;
    const entry = ensureRtcPeer(fromSlot, false);
    if (!entry) return;
    try {
      if (signal.sdp) {
        await entry.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        if (signal.sdp.type === "offer") {
          const answer = await entry.pc.createAnswer();
          await entry.pc.setLocalDescription(answer);
          send(JSON.stringify({
            type: "WEBRTC_SIGNAL",
            toSlot: fromSlot,
            signal: { sdp: answer },
          }));
        }
      } else if (signal.candidate) {
        await entry.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    } catch (_) {}
  }

  function reconcileRtcMesh() {
    if (!state.webrtcEnabled || state.slot < 0) return;
    const activeSlots = new Set();
    for (const p of state.players) {
      if (p.connected && p.slot !== state.slot) {
        activeSlots.add(p.slot);
        if (state.slot < p.slot && !rtcPeers.has(p.slot)) {
          ensureRtcPeer(p.slot, true);
        }
      }
    }
    for (const [slot, entry] of rtcPeers.entries()) {
      if (!activeSlots.has(slot)) {
        try { entry.pc.close(); } catch (_) {}
        rtcPeers.delete(slot);
      }
    }
  }

  function connectRoom(roomCode, opts = {}) {
    const cleanCode = String(roomCode || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "") || generateRoomCode();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    manualClose = false;
    lastConnectOpts = { roomCode: cleanCode, ...opts };

    if (ws) {
      manualClose = true;
      try { ws.close(); } catch (_) {}
      manualClose = false;
    }
    closeAllRtc();

    const params = new URLSearchParams({
      room: cleanCode,
      playerId: state.playerId,
      name: state.playerName,
      charClass: opts.charClass || "IRONCLAD",
      mode: opts.mode || state.mode || "COOP",
      ascension: String(opts.ascension ?? state.ascension ?? 0),
      seed: opts.seedText || "",
    });

    state.connecting = true;
    state.connected = false;
    state.error = "";
    state.roomCode = cleanCode;
    notify();

    const wsUrl = `${getRelayWsBase()}/ws?${params.toString()}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      reconnectAttempts = 0;
      state.connecting = false;
      state.connected = true;
      state.error = "";
      try {
        const u = new URL(window.location.href);
        u.searchParams.set("room", cleanCode);
        window.history.replaceState({}, "", u.toString());
      } catch (_) {}
      notify();
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      incomingQueue.push(ev.data);
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "WELCOME") {
          state.slot = msg.slot;
          state.roomCode = msg.roomCode;
          notify();
        } else if (msg.type === "START_RUN") {
          state.runState = "IN_RUN";
          notify();
          if (window.StsUI && typeof window.StsUI.closeOverlay === "function") {
            window.StsUI.closeOverlay();
          }
        } else if (msg.type === "ROOM_SYNC" && msg.room) {
          const prevRunState = state.runState;
          state.hostId = msg.room.hostId || "";
          state.isHost = state.hostId === state.playerId;
          state.mode = msg.room.mode || "COOP";
          state.ascension = msg.room.ascension || 0;
          state.seedText = msg.room.seedText || "";
          state.seedLong = msg.room.seedLong || "";
          state.runState = msg.room.state || "LOBBY";
          state.floorNum = msg.room.floorNum || 0;
          state.actNum = msg.room.actNum || 1;
          state.players = msg.players || [];
          reconcileRtcMesh();
          notify();
          if (prevRunState !== "IN_RUN" && state.runState === "IN_RUN") {
            if (window.StsUI && typeof window.StsUI.closeOverlay === "function") {
              window.StsUI.closeOverlay();
            }
          }
        } else if (msg.type === "WEBRTC_SIGNAL") {
          handleRtcSignal(msg.fromSlot, msg.signal);
        } else if (msg.type === "ERROR") {
          state.error = msg.message || "Room error";
          notify();
        }
      } catch (_) {}
    };

    ws.onclose = (ev) => {
      const wasManual = manualClose;
      state.connected = false;
      state.connecting = false;
      closeAllRtc();
      if (ev.code === 4000) {
        lastConnectOpts = null;
        state.roomCode = "";
        state.slot = -1;
        state.players = [];
        state.isHost = false;
        state.runState = "LOBBY";
        state.error = ev.reason || "Room dissolved after 1m of inactivity.";
        incomingQueue.push(JSON.stringify({ type: "LOCAL_DISCONNECTED" }));
        try {
          const u = new URL(window.location.href);
          u.searchParams.delete("room");
          window.history.replaceState({}, "", u.toString());
        } catch (_) {}
        notify();
      } else if (!wasManual && ev.code !== 4003 && reconnectAttempts < 10 && lastConnectOpts) {
        reconnectAttempts++;
        const delay = Math.min(8000, 800 * reconnectAttempts);
        state.error = `Reconnecting (${reconnectAttempts}/10)...`;
        notify();
        reconnectTimer = setTimeout(() => connectRoom(lastConnectOpts.roomCode, lastConnectOpts), delay);
      } else {
        if (ev.reason) state.error = ev.reason;
        notify();
      }
    };

    ws.onerror = () => {
      state.error = "Unable to reach WebSocket server.";
      notify();
    };
  }

  function leaveRoom() {
    manualClose = true;
    lastConnectOpts = null;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      try { ws.close(1000, "Leave room"); } catch (_) {}
      ws = null;
    }
    closeAllRtc();
    state.connected = false;
    state.connecting = false;
    state.roomCode = "";
    state.slot = -1;
    state.players = [];
    state.isHost = false;
    state.runState = "LOBBY";
    incomingQueue.push(JSON.stringify({ type: "LOCAL_DISCONNECTED" }));
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete("room");
      window.history.replaceState({}, "", u.toString());
    } catch (_) {}
    notify();
  }

  function send(jsonStr) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (typeof jsonStr === "string" && !jsonStr.includes("\"PING\"")) {
        lastActivityAt = Date.now();
      }
      ws.send(jsonStr);
      return true;
    }
    return false;
  }

  function sendObj(obj) {
    return send(JSON.stringify(obj));
  }

  function poll() {
    if (incomingQueue.length === 0) return [];
    return incomingQueue.splice(0);
  }

  function sendPreview(jsonStr) {
    for (const entry of rtcPeers.values()) {
      if (entry.dc && entry.dc.readyState === "open") {
        try { entry.dc.send(jsonStr); } catch (_) {}
      }
    }
  }

  function pollPreviews() {
    if (previewQueue.length === 0) return [];
    return previewQueue.splice(0);
  }

  async function fetchRooms() {
    const resp = await fetch(`${getRelayHttpBase()}/api/rooms`, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return data.rooms || [];
  }

  function setPlayerName(name, opts = {}) {
    const clean = String(name || "").trim().slice(0, 16) || "SpirePlayer";
    state.playerName = clean;
    localStorage.setItem(PLAYER_NAME_KEY, clean);
    if (state.connected) {
      sendObj({ type: "SET_CHAR", name: clean });
    }
    if (!opts.fromJava && window.__STS_JAVA_SAVE_HOOKS?.setPlayerName) {
      try {
        const curJava = window.__STS_JAVA_SAVE_HOOKS.getPlayerName?.() || "";
        if (curJava !== clean) {
          window.__STS_JAVA_SAVE_HOOKS.setPlayerName(clean);
        }
      } catch (_) {}
    }
    notify();
    return clean;
  }

  function setWebRtcEnabled(enabled) {
    state.webrtcEnabled = !!enabled;
    localStorage.setItem(WEBRTC_ENABLED_KEY, String(state.webrtcEnabled));
    if (!state.webrtcEnabled) closeAllRtc();
    else reconcileRtcMesh();
    notify();
  }

  function getState() {
    let rtcOpen = 0;
    for (const entry of rtcPeers.values()) {
      if (entry.dc && entry.dc.readyState === "open") rtcOpen++;
    }
    return {
      ...state,
      webrtcOpenPeers: rtcOpen,
      inviteUrl: state.roomCode
        ? `${window.location.origin}/?room=${encodeURIComponent(state.roomCode)}`
        : window.location.origin,
    };
  }

  // Activity-gated heartbeat so inactive or backgrounded rooms dissolve after ~1 min
  setInterval(() => {
    if (
      ws &&
      ws.readyState === WebSocket.OPEN &&
      document.visibilityState === "visible" &&
      Date.now() - lastActivityAt < 55000
    ) {
      sendObj({ type: "PING" });
    }
  }, 25000);

  window.StsNetBridge = {
    createRoom: (opts) => connectRoom(generateRoomCode(), opts),
    joinRoom: connectRoom,
    leaveRoom,
    send,
    sendObj,
    poll,
    sendPreview,
    pollPreviews,
    fetchRooms,
    setPlayerName,
    setWebRtcEnabled,
    getState,
    subscribe: (fn) => {
      subscribers.add(fn);
      fn(getState());
      return () => subscribers.delete(fn);
    },
  };
})();
