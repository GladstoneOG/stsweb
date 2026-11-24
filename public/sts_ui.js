// ============================================================================
// Slay the Spire Web — STS UI, Relocatable HUD, Name Sync & Cloud Account Saves
// ============================================================================
(function () {
  const URL_PARAMS = new URLSearchParams(window.location.search || "");
  const PROFILE_TAG = (URL_PARAMS.get("profile") || "").replace(/[^A-Za-z0-9_-]/g, "");
  const AUTH_TOKEN_KEY = "stsweb_auth_token_v1" + (PROFILE_TAG ? "_" + PROFILE_TAG : "");
  const AUTH_USER_KEY = "stsweb_auth_user_v1" + (PROFILE_TAG ? "_" + PROFILE_TAG : "");
  const HUD_POS_KEY = "stsweb_hud_pos_v2";

  const CHARACTER_OPTIONS = [
    { id: "IRONCLAD", label: "The Ironclad", color: "#ef5350", icon: "/ui-assets/char-ironclad.png" },
    { id: "THE_SILENT", label: "The Silent", color: "#48c78e", icon: "/ui-assets/char-silent.png" },
    { id: "DEFECT", label: "The Defect", color: "#65bfff", icon: "/ui-assets/char-defect.png" },
    { id: "WATCHER", label: "The Watcher", color: "#c084fc", icon: "/ui-assets/char-watcher.png" },
  ];

  const STEAM_PREF_NAMES = new Set([
    "STSPlayer",
    "STSUnlockProgress",
    "STSUnlocks",
    "STSAchievements",
    "STSDaily",
    "STSDataVagabond",
    "STSDataTheSilent",
    "STSDataDefect",
    "STSDataWatcher",
    "STSSeenCards",
    "STSSeenRelics",
    "STSSeenBosses",
    "STSGameplaySettings",
    "STSInputSettings",
    "STSInputSettings_Controller",
    "STSSound",
    "STSTips",
    "STSSaveSlots",
    "STSBetaCardPreference",
  ]);

  let activeTab = "lobby";
  let modalOpen = false;
  let hudHidden = false;
  let awakeTimer = null;
  let autoSaveTimer = null;
  let autoSaveInFlight = false;
  let lastCloudSyncAt = null;
  let cloudSyncState = ""; // "", "saving", "saved", "error"

  let roomsCache = [];
  let cloudSlotsCache = [];
  let saveStatusMsg = "";
  let accountStatusMsg = "";
  let authToken = localStorage.getItem(AUTH_TOKEN_KEY) || "";
  let authUser = localStorage.getItem(AUTH_USER_KEY) || "";
  let autoJoinedUrlRoom = false;

  // --------------------------------------------------------------------------
  // Relay / Account Helpers
  // --------------------------------------------------------------------------

  function relayHttpBase() {
    return (window.STS_DEFAULT_RELAY || window.location.origin).replace(/\/+$/, "");
  }

  function getHooks() {
    return window.__STS_JAVA_SAVE_HOOKS || null;
  }

  async function apiFetch(path, opts = {}) {
    const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
    const resp = await fetch(`${relayHttpBase()}${path}`, { ...opts, headers });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  }

  function buildLocalSaveBundle() {
    const hooks = getHooks();
    if (!hooks) return null;
    const paths = hooks.listFiles();
    const files = {};
    for (const p of paths) {
      files[p] = hooks.readFile(p);
    }
    return {
      format: "stsweb_save_bundle_v1",
      exportedAt: new Date().toISOString(),
      fileCount: paths.length,
      files,
    };
  }

  // --------------------------------------------------------------------------
  // Bidirectional Name Sync (Savefile <-> Spire Net <-> Signed-in Account)
  // --------------------------------------------------------------------------

  function syncNameEverywhere(rawName, opts = {}) {
    const clean = String(rawName || "").trim().slice(0, 16);
    if (!clean) return;
    window.StsNetBridge.setPlayerName(clean, { fromJava: opts.fromJava });
    const hooks = getHooks();
    if (!opts.fromJava && hooks?.setPlayerName) {
      const curJava = hooks.getPlayerName ? hooks.getPlayerName() : "";
      if (curJava !== clean) {
        hooks.setPlayerName(clean);
      }
    }
    updateAccountStrip();
    if (modalOpen) renderModal();
  }

  // --------------------------------------------------------------------------
  // Portable Account Save Persistence (Cloudflare SQLite account_saves)
  // --------------------------------------------------------------------------

  async function saveAccountBundleNow(silent = false) {
    if (!authToken || !getHooks()) return;
    const bundle = buildLocalSaveBundle();
    if (!bundle) return;
    autoSaveInFlight = true;
    cloudSyncState = "saving";
    updateAccountStrip();
    try {
      const res = await apiFetch("/api/account/save", {
        method: "PUT",
        body: JSON.stringify({ payload: bundle }),
      });
      lastCloudSyncAt = res.updated_at || Date.now();
      cloudSyncState = "saved";
      if (!silent) {
        accountStatusMsg = `Saved ${bundle.fileCount} profile & run file(s) to "${authUser}".`;
      }
    } catch (e) {
      cloudSyncState = "error";
      if (!silent) accountStatusMsg = `Auto-save failed: ${e.message}`;
    } finally {
      autoSaveInFlight = false;
      updateAccountStrip();
      if (modalOpen && activeTab === "saves") renderModal();
    }
  }

  function scheduleAccountAutoSave() {
    if (!authToken) return;
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null;
      saveAccountBundleNow(true);
    }, 900);
  }

  async function restoreAccountBundleOnLogin() {
    if (!authToken) return;
    try {
      const res = await apiFetch("/api/account/save");
      if (res.hasSave && res.payload?.files && getHooks()) {
        const hooks = getHooks();
        const files = res.payload.files;
        let count = 0;
        for (const [k, v] of Object.entries(files)) {
          if (hooks.writeFile(k, String(v))) count++;
        }
        hooks.reloadPrefs();
        syncNameEverywhere(authUser);
        lastCloudSyncAt = res.updated_at || Date.now();
        cloudSyncState = "saved";
        accountStatusMsg = `Signed in as ${authUser}. Loaded ${count} portable save file(s) from Cloudflare SQLite.`;
      } else {
        syncNameEverywhere(authUser);
        await saveAccountBundleNow(true);
        accountStatusMsg = `Signed in as ${authUser}. Your saves will now auto-sync to this account.`;
      }
      await refreshCloudSlots();
    } catch (e) {
      if (String(e.message).includes("401") || String(e.message).includes("Unauthorized")) {
        signOutAccount(true);
      } else {
        accountStatusMsg = `Cloud restore warning: ${e.message}`;
      }
    }
    updateAccountStrip();
    if (modalOpen) renderModal();
  }

  function signOutAccount(silent = false) {
    authToken = "";
    authUser = "";
    lastCloudSyncAt = null;
    cloudSyncState = "";
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
    cloudSlotsCache = [];
    if (!silent) accountStatusMsg = "Signed out of portable cloud account.";
    updateAccountStrip();
    if (modalOpen) renderModal();
  }

  async function accountAuth(mode, username, password) {
    accountStatusMsg = mode === "register" ? "Creating Spire account..." : "Signing into Spire account...";
    renderModal();
    try {
      const res = await apiFetch(`/api/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify({ username: String(username || "").trim(), password }),
      });
      authToken = res.token;
      authUser = res.username;
      localStorage.setItem(AUTH_TOKEN_KEY, authToken);
      localStorage.setItem(AUTH_USER_KEY, authUser);
      await restoreAccountBundleOnLogin();
    } catch (e) {
      accountStatusMsg = `Account error: ${e.message}`;
      renderModal();
    }
  }

  window.StsSaveBridge = {
    onJavaHooksReady: () => {
      const hooks = getHooks();
      const javaName = hooks?.getPlayerName ? hooks.getPlayerName() : "";
      if (authToken && authUser) {
        restoreAccountBundleOnLogin();
      } else if (javaName) {
        syncNameEverywhere(javaName, { fromJava: true });
      }
      updateAccountStrip();
      if (modalOpen) renderModal();
    },
    onJavaPlayerNameChanged: (name) => {
      if (name && name.trim()) {
        syncNameEverywhere(name, { fromJava: true });
        scheduleAccountAutoSave();
      }
    },
    onLocalSaved: () => {
      scheduleAccountAutoSave();
    },
    onLocalDeleted: () => {
      scheduleAccountAutoSave();
    },
  };

  window.addEventListener("pagehide", () => {
    if (!authToken || !getHooks()) return;
    const bundle = buildLocalSaveBundle();
    if (!bundle) return;
    try {
      fetch(`${relayHttpBase()}/api/account/save`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ payload: bundle }),
        keepalive: true,
      }).catch(() => {});
    } catch (_) {}
  });

  // --------------------------------------------------------------------------
  // Manual Steam Saves & Optional 3-Slot Snapshots
  // --------------------------------------------------------------------------

  function exportAllLocalBundle() {
    const bundle = buildLocalSaveBundle();
    if (!bundle) {
      saveStatusMsg = "Wait for Spire engine boot to finish before exporting.";
      renderModal();
      return;
    }
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `stsweb-${(window.StsNetBridge.getState().playerName || "save").toLowerCase()}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    saveStatusMsg = `Exported ${bundle.fileCount} save/preference file(s).`;
    renderModal();
  }

  function mapSteamFilenameToVfsPath(name) {
    const base = name.split(/[/\\]/).pop();
    const stripped = base.replace(/^[0-3]_/, "");
    if (base.endsWith(".autosave") || base.endsWith(".autosave.backUp") || base.endsWith(".autosaveBETA")) {
      return `saves/${base}`;
    }
    if (STEAM_PREF_NAMES.has(base) || STEAM_PREF_NAMES.has(stripped)) {
      return `preferences/${base}`;
    }
    if (base === "info.displayconfig") return "info.displayconfig";
    return null;
  }

  async function importFileList(fileList) {
    const hooks = getHooks();
    if (!hooks) {
      saveStatusMsg = "Engine still booting — try again in a moment.";
      renderModal();
      return;
    }
    let imported = 0;
    for (const file of fileList) {
      const text = await file.text();
      if (file.name.toLowerCase().endsWith(".json")) {
        try {
          const parsed = JSON.parse(text);
          if (parsed && parsed.format === "stsweb_save_bundle_v1" && parsed.files) {
            for (const [k, v] of Object.entries(parsed.files)) {
              if (hooks.writeFile(k, String(v))) imported++;
            }
            continue;
          }
        } catch (_) {}
      }
      const vfsPath = mapSteamFilenameToVfsPath(file.name);
      if (vfsPath && hooks.writeFile(vfsPath, text)) {
        imported++;
      }
    }
    if (imported > 0) {
      hooks.reloadPrefs();
      scheduleAccountAutoSave();
      saveStatusMsg = `Imported ${imported} Steam save/preference file(s) and reloaded game.`;
    } else {
      saveStatusMsg = "No recognized Slay the Spire preference or .autosave files found.";
    }
    renderModal();
  }

  function unlockAllContent() {
    const hooks = getHooks();
    if (!hooks) return;

    const unlockProgress = {
      IRONCLADProgress: "100000", IRONCLADCurrentCost: "0", IRONCLADUnlockLevel: "5", IRONCLADTotalScore: "100000",
      THE_SILENTProgress: "100000", THE_SILENTCurrentCost: "0", THE_SILENTUnlockLevel: "5", THE_SILENTTotalScore: "100000",
      DEFECTProgress: "100000", DEFECTCurrentCost: "0", DEFECTUnlockLevel: "5", DEFECTTotalScore: "100000",
      WATCHERProgress: "100000", WATCHERCurrentCost: "0", WATCHERUnlockLevel: "5", WATCHERTotalScore: "100000",
    };
    const charPrefs = { WIN_COUNT: "1", ASCENSION_LEVEL: "20", LAST_ASCENSION_LEVEL: "20" };
    const unlocks = {
      THE_SILENT: "2", DEFECT: "2", WATCHER: "2",
      "The Silent": "2", Defect: "2", Watcher: "2",
    };

    const playerPref = (() => {
      try { return JSON.parse(hooks.readFile("preferences/STSPlayer") || "{}"); } catch (_) { return {}; }
    })();
    playerPref.IRONCLAD_WIN = "true";
    playerPref.THE_SILENT_WIN = "true";
    playerPref.DEFECT_WIN = "true";
    playerPref.WATCHER_WIN = "true";

    hooks.writeFile("preferences/STSUnlockProgress", JSON.stringify(unlockProgress, null, 2));
    hooks.writeFile("preferences/STSUnlocks", JSON.stringify(unlocks, null, 2));
    hooks.writeFile("preferences/STSPlayer", JSON.stringify(playerPref, null, 2));
    for (const f of ["STSDataVagabond", "STSDataTheSilent", "STSDataDefect", "STSDataWatcher"]) {
      let existing = {};
      try { existing = JSON.parse(hooks.readFile(`preferences/${f}`) || "{}"); } catch (_) {}
      Object.assign(existing, charPrefs);
      hooks.writeFile(`preferences/${f}`, JSON.stringify(existing, null, 2));
    }
    hooks.reloadPrefs();
    scheduleAccountAutoSave();
    saveStatusMsg = "Unlocked all 4 characters, cards, relics, Act 4 & Ascension 20!";
    renderModal();
  }

  async function refreshCloudSlots() {
    if (!authToken) {
      cloudSlotsCache = [];
      return;
    }
    try {
      const res = await apiFetch("/api/saves");
      cloudSlotsCache = res.slots || [];
      authUser = res.username || authUser;
    } catch (e) {
      if (String(e.message).includes("401") || String(e.message).includes("Unauthorized")) {
        signOutAccount(true);
      }
    }
    if (modalOpen && activeTab === "saves") renderModal();
  }

  async function uploadCloudSlot(slot) {
    const bundle = buildLocalSaveBundle();
    if (!bundle) return;
    const label = `${window.StsNetBridge.getState().playerName || authUser} (${bundle.fileCount} files)`;
    saveStatusMsg = `Uploading Snapshot Slot ${slot}...`;
    renderModal();
    try {
      await apiFetch(`/api/saves/${slot}`, { method: "PUT", body: JSON.stringify({ label, payload: bundle }) });
      saveStatusMsg = `Saved snapshot to Cloud Slot ${slot}.`;
      await refreshCloudSlots();
    } catch (e) {
      saveStatusMsg = `Upload failed: ${e.message}`;
      renderModal();
    }
  }

  async function downloadCloudSlot(slot) {
    const hooks = getHooks();
    if (!hooks) return;
    saveStatusMsg = `Restoring Snapshot Slot ${slot}...`;
    renderModal();
    try {
      const res = await apiFetch(`/api/saves/${slot}`);
      const files = res.payload?.files || {};
      let count = 0;
      for (const [k, v] of Object.entries(files)) {
        if (hooks.writeFile(k, String(v))) count++;
      }
      hooks.reloadPrefs();
      scheduleAccountAutoSave();
      saveStatusMsg = `Restored ${count} files from Cloud Slot ${slot}.`;
      renderModal();
    } catch (e) {
      saveStatusMsg = `Restore failed: ${e.message}`;
      renderModal();
    }
  }

  // --------------------------------------------------------------------------
  // Auto-Hiding & Relocatable HUD Logic
  // --------------------------------------------------------------------------

  function clampHudPosition(x, y) {
    const zone = document.getElementById("sts-hud-zone");
    const pill = document.getElementById("sts-hud-pill");
    const w = Math.max(220, pill?.offsetWidth || 280);
    const h = Math.max(38, zone?.offsetHeight || 42);
    return {
      x: Math.max(8, Math.min(window.innerWidth - w - 8, x)),
      y: Math.max(8, Math.min(window.innerHeight - h - 8, y)),
    };
  }

  function applyHudPosition(x, y) {
    const zone = document.getElementById("sts-hud-zone");
    if (!zone) return;
    const pos = clampHudPosition(x, y);
    zone.style.left = `${pos.x}px`;
    zone.style.top = `${pos.y}px`;
  }

  function loadHudPosition() {
    try {
      const raw = localStorage.getItem(HUD_POS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed.x === "number" && typeof parsed.y === "number") {
          applyHudPosition(parsed.x, parsed.y);
          return;
        }
      }
    } catch (_) {}
    applyHudPosition(10, Math.round(window.innerHeight * 0.44));
  }

  function resetHudPosition() {
    localStorage.removeItem(HUD_POS_KEY);
    loadHudPosition();
    wakeHudBrief(2600);
  }

  function wakeHudBrief(ms = 2600) {
    const zone = document.getElementById("sts-hud-zone");
    if (!zone) return;
    zone.classList.add("awake");
    if (awakeTimer) clearTimeout(awakeTimer);
    awakeTimer = setTimeout(() => {
      zone.classList.remove("awake");
      awakeTimer = null;
    }, ms);
  }

  function initHudDrag() {
    const zone = document.getElementById("sts-hud-zone");
    const grip = document.getElementById("sts-hud-grip");
    const tab = document.getElementById("sts-hud-tab");
    if (!zone) return;

    const startDrag = (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const rect = zone.getBoundingClientRect();
      const offsetX = ev.clientX - rect.left;
      const offsetY = ev.clientY - rect.top;
      zone.classList.add("dragging");

      const onMove = (me) => {
        applyHudPosition(me.clientX - offsetX, me.clientY - offsetY);
      };
      const onUp = () => {
        zone.classList.remove("dragging");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const r = zone.getBoundingClientRect();
        localStorage.setItem(HUD_POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
        wakeHudBrief(2000);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };

    grip?.addEventListener("pointerdown", startDrag);
    tab?.addEventListener("pointerdown", startDrag);
    window.addEventListener("resize", loadHudPosition);
  }

  function updateHudPill() {
    const zone = document.getElementById("sts-hud-zone");
    if (!zone) return;
    zone.dataset.hidden = hudHidden ? "true" : "false";

    const net = window.StsNetBridge.getState();
    const badge = document.getElementById("sts-hud-room");
    const inviteBtn = document.getElementById("sts-hud-invite");
    if (net.connected) {
      badge.textContent = `${net.mode} · ${net.roomCode} (${net.players.filter((p) => p.connected).length}P)`;
      badge.className = "sts-badge online";
      inviteBtn.style.display = "inline-flex";
    } else if (net.connecting) {
      badge.textContent = `Joining ${net.roomCode}...`;
      badge.className = "sts-badge warn";
      inviteBtn.style.display = "none";
    } else {
      badge.textContent = `${net.playerName} · Solo`;
      badge.className = "sts-badge";
      inviteBtn.style.display = "none";
    }
  }

  // --------------------------------------------------------------------------
  // Modal Rendering
  // --------------------------------------------------------------------------

  function escHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function updateAccountStrip() {
    const strip = document.getElementById("sts-account-bar");
    if (!strip) return;
    const net = window.StsNetBridge.getState();
    const syncLabel = !authToken
      ? `<span class="sts-tag">LOCAL PROFILE</span>`
      : cloudSyncState === "saving"
        ? `<span class="sts-tag gold">SYNCING TO SQLITE...</span>`
        : cloudSyncState === "error"
          ? `<span class="sts-tag red">SYNC WARNING</span>`
          : `<span class="sts-tag green">SQLITE AUTO-SYNC ✓${lastCloudSyncAt ? ` · ${new Date(lastCloudSyncAt).toLocaleTimeString()}` : ""}</span>`;

    strip.innerHTML = `
      <div class="sts-row">
        <span class="sts-muted">Active Save Name:</span>
        <strong style="color:var(--gold)">${escHtml(net.playerName)}</strong>
        ${authUser ? `<span class="sts-muted">· Account: <strong>${escHtml(authUser)}</strong></span>` : ""}
        ${syncLabel}
      </div>
      <div class="sts-row">
        ${authToken
          ? `<button id="sts-btn-sync-now" class="sts-btn small primary">Sync Save Now</button>`
          : `<button id="sts-btn-go-account" class="sts-btn small gold">Sign In for Portable Saves</button>`}
      </div>`;

    document.getElementById("sts-btn-sync-now")?.addEventListener("click", () => saveAccountBundleNow(false));
    document.getElementById("sts-btn-go-account")?.addEventListener("click", () => openOverlay("saves"));
  }

  async function refreshRoomsList() {
    try {
      roomsCache = await window.StsNetBridge.fetchRooms();
    } catch (_) {
      roomsCache = [];
    }
    if (modalOpen && activeTab === "lobby") renderModal();
  }

  function openOverlay(tab) {
    if (tab) activeTab = tab;
    modalOpen = true;
    const overlay = document.getElementById("sts-modal-backdrop");
    if (overlay) overlay.hidden = false;
    if (activeTab === "lobby") refreshRoomsList();
    if (activeTab === "saves") refreshCloudSlots();
    renderModal();
  }

  function closeOverlay() {
    modalOpen = false;
    const overlay = document.getElementById("sts-modal-backdrop");
    if (overlay) overlay.hidden = true;
    const canvas = document.getElementById("canvas");
    if (canvas) canvas.focus();
  }

  function toggleOverlay() {
    if (modalOpen) closeOverlay();
    else openOverlay();
  }

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        if (navigator.keyboard && navigator.keyboard.lock) {
          navigator.keyboard.lock(["Escape"]).catch(() => {});
        }
      } else {
        await document.exitFullscreen();
      }
    } catch (_) {}
  }

  function renderLobbyTab(net) {
    const me = net.players.find((p) => p.playerId === net.playerId);
    if (!net.connected) {
      const roomsRows = roomsCache.length === 0
        ? `<div class="sts-empty sts-italic">No active Spire parties yet. Host a room to begin!</div>`
        : roomsCache.map((r) => `
            <div class="sts-room-row">
              <div>
                <strong style="color:var(--gold)">${escHtml(r.code)}</strong>
                <span class="sts-tag">${escHtml(r.mode)}</span>
                <span class="sts-muted">
                  Host: ${escHtml(r.host_name)} ·
                  <img class="sts-ico" src="/ui-assets/icon-ascension.png" alt="" />${r.ascension} ·
                  ${r.player_count}/${r.max_players}P ·
                  ${r.state === "IN_RUN" ? `<img class="sts-ico" src="/ui-assets/icon-floor.png" alt="" /> ${r.floor_num}` : "Lobby"}
                </span>
              </div>
              <button class="sts-btn small primary" data-join-code="${escHtml(r.code)}">Join</button>
            </div>`).join("");

      return `
        <div class="sts-grid-2">
          <div class="sts-card">
            <h3>Host Co-op / Race</h3>
            <label class="sts-field">
              <span>Player Name (Synced with STS Save Slot)</span>
              <div class="sts-row">
                <input id="sts-in-name" type="text" maxlength="16" value="${escHtml(net.playerName)}" style="flex:1" />
                <button id="sts-btn-save-name" class="sts-btn small">Apply</button>
              </div>
            </label>
            <div class="sts-row">
              <label class="sts-field" style="flex:1">
                <span>Mode</span>
                <select id="sts-in-mode">
                  <option value="COOP" ${net.mode === "COOP" ? "selected" : ""}>Shared-Battlefield Co-op (1-6P)</option>
                  <option value="RACE" ${net.mode === "RACE" ? "selected" : ""}>Seeded Race / Versus</option>
                </select>
              </label>
              <label class="sts-field" style="width:110px">
                <span>Ascension</span>
                <input id="sts-in-asc" type="number" min="0" max="20" value="${net.ascension}" />
              </label>
            </div>
            <label class="sts-field">
              <span>Custom Seed (optional)</span>
              <input id="sts-in-seed" type="text" maxlength="24" placeholder="Random seeded run" value="${escHtml(net.seedText)}" />
            </label>
            <button id="sts-btn-create" class="sts-btn gold full">Create &amp; Host Room</button>
          </div>

          <div class="sts-card">
            <h3>Join Room</h3>
            <div class="sts-row">
              <input id="sts-in-join-code" type="text" maxlength="16" placeholder="Room Code (e.g. X7K9P)" style="flex:1;text-transform:uppercase" />
              <button id="sts-btn-join-code" class="sts-btn primary">Join</button>
            </div>
            <div class="sts-row" style="justify-content:space-between;margin-top:14px">
              <span class="sts-muted">Public Spire Parties</span>
              <button id="sts-btn-refresh-rooms" class="sts-btn small">Refresh</button>
            </div>
            <div class="sts-room-list">${roomsRows}</div>
          </div>
        </div>
        ${net.error ? `<div class="sts-alert error">${escHtml(net.error)}</div>` : ""}`;
    }

    const playerRows = net.players.map((p) => {
      const charInfo = CHARACTER_OPTIONS.find((c) => c.id === p.charClass) || CHARACTER_OPTIONS[0];
      const isMe = p.playerId === net.playerId;
      return `
        <div class="sts-player-row ${p.connected ? "" : "offline"}">
          <div class="sts-player-ident">
            <img class="sts-char-icon" src="${charInfo.icon}" alt="" style="border-color:${charInfo.color}" />
            <strong style="color:${charInfo.color}">${escHtml(p.name)}</strong>
            ${p.playerId === net.hostId ? `<span class="sts-tag gold">HOST</span>` : ""}
            ${!p.connected ? `<span class="sts-tag">OFFLINE</span>` : ""}
            ${p.isDowned ? `<span class="sts-tag red">DOWNED</span>` : ""}
          </div>
          <div class="sts-player-meta">
            ${isMe && net.runState === "LOBBY" ? `
              <select id="sts-my-char" class="sts-select-sm">
                ${CHARACTER_OPTIONS.map((c) => `<option value="${c.id}" ${c.id === p.charClass ? "selected" : ""}>${c.label}</option>`).join("")}
              </select>
            ` : `<span style="color:${charInfo.color}">${charInfo.label}</span>`}
            ${net.runState === "IN_RUN"
              ? `<span class="sts-muted">
                   <img class="sts-ico" src="/ui-assets/icon-heart.png" alt="" />${p.hp}/${p.maxHp} ·
                   <img class="sts-ico" src="/ui-assets/icon-gold.png" alt="" />${p.gold} ·
                   <img class="sts-ico" src="/ui-assets/icon-floor.png" alt="" />${p.floorNum}
                 </span>`
              : `<span class="sts-tag ${p.ready ? "green" : ""}">${p.ready ? "READY" : "WAITING"}</span>`}
            ${!isMe && net.runState === "IN_RUN" && net.mode === "COOP" ? `
              <button class="sts-btn small gold" data-send-gold="${p.slot}" title="Gift 25 Gold">+25g</button>
            ` : ""}
          </div>
        </div>`;
    }).join("");

    return `
      <div class="sts-card">
        <div class="sts-row" style="justify-content:space-between;align-items:center;margin-bottom:12px">
          <div>
            <h3 style="margin:0">Room ${escHtml(net.roomCode)} · ${escHtml(net.mode)}</h3>
            <div class="sts-muted">
              <img class="sts-ico" src="/ui-assets/icon-ascension.png" alt="" />Ascension ${net.ascension} ·
              ${net.runState === "IN_RUN" ? `Act ${net.actNum} · Floor ${net.floorNum} · Seed ${escHtml(net.seedLong)}` : "Waiting in Spire Camp"}
            </div>
          </div>
          <div class="sts-row">
            <button id="sts-btn-copy-invite" class="sts-btn primary">Copy Invite Link</button>
            <button id="sts-btn-leave" class="sts-btn danger">Leave Room</button>
          </div>
        </div>

        <div class="sts-player-list">${playerRows}</div>

        ${net.runState === "LOBBY" ? `
          <div class="sts-row" style="margin-top:14px;justify-content:space-between;align-items:center">
            <button id="sts-btn-toggle-ready" class="sts-btn ${me && me.ready ? "success" : ""}">${me && me.ready ? "Ready ✓" : "Mark Ready"}</button>
            ${net.isHost ? `
              <div class="sts-row">
                <select id="sts-host-mode" class="sts-select-sm">
                  <option value="COOP" ${net.mode === "COOP" ? "selected" : ""}>Shared Co-op</option>
                  <option value="RACE" ${net.mode === "RACE" ? "selected" : ""}>Seed Race</option>
                </select>
                <input id="sts-host-asc" type="number" min="0" max="20" value="${net.ascension}" style="width:66px" title="Ascension Level" />
                <button id="sts-btn-start-run" class="sts-btn gold">Embark Together!</button>
              </div>
            ` : `<span class="sts-italic">Waiting for host to embark...</span>`}
          </div>
        ` : `<div class="sts-alert">Shared adventure in progress — if anyone refreshes, rejoining <strong>?room=${escHtml(net.roomCode)}</strong> restores them seamlessly.</div>`}
      </div>`;
  }

  function renderAccountAndSavesTab(net) {
    const hooks = getHooks();
    const count = hooks ? hooks.listFiles().length : 0;

    const accountHtml = !authToken ? `
      <div class="sts-card">
        <h3>Portable Spire Account</h3>
        <p class="sts-italic">Sign in with any username &amp; password. Your profile name and all saves automatically follow your account via Cloudflare SQLite.</p>
        <label class="sts-field">
          <span>Account Username (Syncs with STS Save Slot)</span>
          <input id="sts-auth-user" type="text" maxlength="16" placeholder="Letters, numbers, _ . -" value="${escHtml(net.playerName !== "SpirePlayer" ? net.playerName : "")}" />
        </label>
        <label class="sts-field">
          <span>Password</span>
          <input id="sts-auth-pass" type="password" placeholder="Min 4 characters" />
        </label>
        <div class="sts-row">
          <button id="sts-btn-login" class="sts-btn primary" style="flex:1">Sign In &amp; Load</button>
          <button id="sts-btn-register" class="sts-btn gold" style="flex:1">Create Account</button>
        </div>
        ${accountStatusMsg ? `<div class="sts-alert">${escHtml(accountStatusMsg)}</div>` : ""}
      </div>` : `
      <div class="sts-card">
        <div class="sts-row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
          <h3 style="margin:0">Account: ${escHtml(authUser)}</h3>
          <button id="sts-btn-logout" class="sts-btn small danger">Sign Out</button>
        </div>
        <p class="sts-italic">All unlocks, preferences &amp; active runs are automatically saved to Cloudflare SQLite whenever Slay the Spire writes a save.</p>
        <div class="sts-row" style="margin-bottom:10px">
          <button id="sts-btn-acc-push" class="sts-btn primary small">Force Save to Cloud</button>
          <button id="sts-btn-acc-pull" class="sts-btn small">Reload From Cloud</button>
        </div>
        ${cloudSlotsCache.length > 0 ? `<div class="sts-muted" style="margin-bottom:6px">Manual Backup Slots:</div>` : ""}
        <div class="sts-room-list">
          ${[1, 2, 3].map((slot) => {
            const info = cloudSlotsCache.find((s) => s.slot === slot);
            return `
              <div class="sts-room-row" style="padding:6px 10px">
                <div>
                  <strong>Slot ${slot}</strong>
                  <span class="sts-muted">${info ? `${(info.bytes / 1024).toFixed(1)} KB` : "Empty"}</span>
                </div>
                <div class="sts-row">
                  <button class="sts-btn small" data-cloud-put="${slot}">Backup</button>
                  ${info ? `<button class="sts-btn small primary" data-cloud-get="${slot}">Restore</button>` : ""}
                </div>
              </div>`;
          }).join("")}
        </div>
        ${accountStatusMsg ? `<div class="sts-alert">${escHtml(accountStatusMsg)}</div>` : ""}
      </div>`;

    return `
      <div class="sts-grid-2">
        ${accountHtml}
        <div class="sts-card">
          <h3>Steam Save Import &amp; Unlocks</h3>
          <p class="sts-italic">Drop Steam files (<code>STSPlayer</code>, <code>STSUnlockProgress</code>, <code>STSData*</code>, <code>*.autosave</code>) or an exported <code>.json</code> bundle. Currently tracking <strong>${count}</strong> local VFS file(s).</p>
          <label id="sts-dropzone" class="sts-dropzone">
            <input id="sts-import-input" type="file" multiple hidden />
            <span>Drop Steam Save / Pref files here or <u>Click to Browse</u></span>
          </label>
          <div class="sts-row" style="margin-top:12px">
            <button id="sts-btn-export" class="sts-btn primary">Export Bundle (.json)</button>
            <button id="sts-btn-unlock-all" class="sts-btn gold">Unlock All + A20</button>
          </div>
          ${saveStatusMsg ? `<div class="sts-alert">${escHtml(saveStatusMsg)}</div>` : ""}
        </div>
      </div>`;
  }

  function renderSettingsTab(net) {
    const assetStatus = window.StsAssetLoader ? window.StsAssetLoader.getStatus() : {};
    return `
      <div class="sts-card">
        <h3><img class="sts-ico" src="/ui-assets/icon-settings.png" alt="" /> Browser &amp; HUD Settings</h3>
        <label class="sts-check">
          <input id="sts-chk-webrtc" type="checkbox" ${net.webrtcEnabled ? "checked" : ""} />
          <span>Enable WebRTC P2P DataChannel for ally cursor previews (falls back silently if blocked)</span>
        </label>
        <div class="sts-row" style="margin-top:16px">
          <button id="sts-btn-reset-hud" class="sts-btn primary">Reset HUD Pill Position (Left Edge)</button>
          <button id="sts-btn-fullscreen" class="sts-btn">Toggle Fullscreen (F11)</button>
          <button id="sts-btn-clear-cache" class="sts-btn danger">Clear Asset Cache &amp; Reload</button>
        </div>
        <p class="sts-muted" style="margin-top:14px">
          Asset Packs: ${assetStatus.actsLoaded ? "Core + Acts II–IV Cached ✓" : "Core Ready (Acts streaming)"} ·
          WebRTC Peers Open: ${net.webrtcOpenPeers || 0} ·
          Hotkeys: <code>F2</code> Spire Net · <code>F9</code> Hide HUD Tab · <code>F11</code> Fullscreen
        </p>
      </div>`;
  }

  function renderModal() {
    updateHudPill();
    updateAccountStrip();
    const body = document.getElementById("sts-modal-body");
    if (!body || !modalOpen) return;

    document.querySelectorAll(".sts-tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === activeTab);
    });

    const net = window.StsNetBridge.getState();
    if (activeTab === "lobby") body.innerHTML = renderLobbyTab(net);
    else if (activeTab === "saves") body.innerHTML = renderAccountAndSavesTab(net);
    else body.innerHTML = renderSettingsTab(net);

    bindModalEvents();
  }

  function bindModalEvents() {
    const byId = (id) => document.getElementById(id);

    if (byId("sts-btn-save-name")) {
      byId("sts-btn-save-name").onclick = () => {
        syncNameEverywhere(byId("sts-in-name")?.value || "");
      };
    }

    if (byId("sts-btn-create")) {
      byId("sts-btn-create").onclick = () => {
        syncNameEverywhere(byId("sts-in-name").value);
        window.StsNetBridge.createRoom({
          mode: byId("sts-in-mode").value,
          ascension: parseInt(byId("sts-in-asc").value, 10) || 0,
          seedText: byId("sts-in-seed").value.trim(),
        });
      };
    }

    if (byId("sts-btn-join-code")) {
      byId("sts-btn-join-code").onclick = () => {
        if (byId("sts-in-name")) syncNameEverywhere(byId("sts-in-name").value);
        const code = byId("sts-in-join-code").value.trim();
        if (code) window.StsNetBridge.joinRoom(code);
      };
    }

    if (byId("sts-btn-refresh-rooms")) byId("sts-btn-refresh-rooms").onclick = refreshRoomsList;

    document.querySelectorAll("[data-join-code]").forEach((btn) => {
      btn.onclick = () => {
        if (byId("sts-in-name")) syncNameEverywhere(byId("sts-in-name").value);
        window.StsNetBridge.joinRoom(btn.dataset.joinCode);
      };
    });

    if (byId("sts-my-char")) {
      byId("sts-my-char").onchange = (e) => {
        window.StsNetBridge.sendObj({ type: "SET_CHAR", charClass: e.target.value });
      };
    }

    if (byId("sts-btn-toggle-ready")) {
      byId("sts-btn-toggle-ready").onclick = () => {
        const net = window.StsNetBridge.getState();
        const me = net.players.find((p) => p.playerId === net.playerId);
        window.StsNetBridge.sendObj({ type: "SET_CHAR", ready: !(me && me.ready) });
      };
    }

    if (byId("sts-host-mode")) {
      byId("sts-host-mode").onchange = (e) => {
        window.StsNetBridge.sendObj({ type: "SET_CHAR", mode: e.target.value });
      };
    }

    if (byId("sts-host-asc")) {
      byId("sts-host-asc").onchange = (e) => {
        window.StsNetBridge.sendObj({ type: "SET_CHAR", ascension: parseInt(e.target.value, 10) || 0 });
      };
    }

    if (byId("sts-btn-start-run")) {
      byId("sts-btn-start-run").onclick = () => {
        const net = window.StsNetBridge.getState();
        window.StsNetBridge.sendObj({
          type: "START_RUN",
          mode: byId("sts-host-mode")?.value || net.mode,
          ascension: parseInt(byId("sts-host-asc")?.value || net.ascension, 10) || 0,
        });
        closeOverlay();
      };
    }

    if (byId("sts-btn-copy-invite")) {
      byId("sts-btn-copy-invite").onclick = async () => {
        const url = window.StsNetBridge.getState().inviteUrl;
        try { await navigator.clipboard.writeText(url); } catch (_) {}
        byId("sts-btn-copy-invite").textContent = "Copied!";
        setTimeout(() => { if (byId("sts-btn-copy-invite")) byId("sts-btn-copy-invite").textContent = "Copy Invite Link"; }, 1600);
      };
    }

    if (byId("sts-btn-leave")) byId("sts-btn-leave").onclick = () => window.StsNetBridge.leaveRoom();

    document.querySelectorAll("[data-send-gold]").forEach((btn) => {
      btn.onclick = () => {
        if (window.__STS_JAVA_COOP_HOOKS?.sendTradeGold) {
          window.__STS_JAVA_COOP_HOOKS.sendTradeGold(parseInt(btn.dataset.sendGold, 10), 25);
        }
      };
    });

    if (byId("sts-btn-login")) {
      byId("sts-btn-login").onclick = () => accountAuth("login", byId("sts-auth-user").value, byId("sts-auth-pass").value);
    }
    if (byId("sts-btn-register")) {
      byId("sts-btn-register").onclick = () => accountAuth("register", byId("sts-auth-user").value, byId("sts-auth-pass").value);
    }
    if (byId("sts-btn-logout")) byId("sts-btn-logout").onclick = () => signOutAccount(false);
    if (byId("sts-btn-acc-push")) byId("sts-btn-acc-push").onclick = () => saveAccountBundleNow(false);
    if (byId("sts-btn-acc-pull")) byId("sts-btn-acc-pull").onclick = () => restoreAccountBundleOnLogin();

    document.querySelectorAll("[data-cloud-put]").forEach((b) => {
      b.onclick = () => uploadCloudSlot(parseInt(b.dataset.cloudPut, 10));
    });
    document.querySelectorAll("[data-cloud-get]").forEach((b) => {
      b.onclick = () => downloadCloudSlot(parseInt(b.dataset.cloudGet, 10));
    });

    if (byId("sts-import-input")) {
      byId("sts-import-input").onchange = (e) => importFileList(e.target.files);
    }
    if (byId("sts-dropzone")) {
      const dz = byId("sts-dropzone");
      dz.ondragover = (e) => { e.preventDefault(); dz.classList.add("dragover"); };
      dz.ondragleave = () => dz.classList.remove("dragover");
      dz.ondrop = (e) => {
        e.preventDefault();
        dz.classList.remove("dragover");
        if (e.dataTransfer?.files) importFileList(e.dataTransfer.files);
      };
    }
    if (byId("sts-btn-export")) byId("sts-btn-export").onclick = exportAllLocalBundle;
    if (byId("sts-btn-unlock-all")) byId("sts-btn-unlock-all").onclick = unlockAllContent;

    if (byId("sts-chk-webrtc")) {
      byId("sts-chk-webrtc").onchange = (e) => window.StsNetBridge.setWebRtcEnabled(e.target.checked);
    }
    if (byId("sts-btn-reset-hud")) byId("sts-btn-reset-hud").onclick = resetHudPosition;
    if (byId("sts-btn-fullscreen")) byId("sts-btn-fullscreen").onclick = toggleFullscreen;
    if (byId("sts-btn-clear-cache")) {
      byId("sts-btn-clear-cache").onclick = async () => {
        if (window.StsAssetLoader) await window.StsAssetLoader.clearCache();
        window.location.reload();
      };
    }
  }

  function init() {
    loadHudPosition();
    initHudDrag();
    wakeHudBrief(2600);

    document.getElementById("sts-hud-open")?.addEventListener("click", () => openOverlay("lobby"));
    document.getElementById("sts-hud-fs")?.addEventListener("click", toggleFullscreen);
    document.getElementById("sts-hud-invite")?.addEventListener("click", async () => {
      const url = window.StsNetBridge.getState().inviteUrl;
      try { await navigator.clipboard.writeText(url); } catch (_) {}
      const btn = document.getElementById("sts-hud-invite");
      if (btn) {
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = "Invite"; }, 1400);
      }
    });
    document.getElementById("sts-modal-close")?.addEventListener("click", closeOverlay);
    document.getElementById("sts-modal-backdrop")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeOverlay();
    });
    document.querySelectorAll(".sts-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeTab = btn.dataset.tab;
        if (activeTab === "lobby") refreshRoomsList();
        if (activeTab === "saves") refreshCloudSlots();
        renderModal();
      });
    });

    // Global capture-phase key guard so modal inputs never bleed into LibGDX canvas
    window.addEventListener("keydown", (e) => {
      if (e.key === "F2") {
        e.preventDefault();
        e.stopPropagation();
        toggleOverlay();
        return;
      }
      if (e.key === "F9") {
        e.preventDefault();
        e.stopPropagation();
        hudHidden = !hudHidden;
        updateHudPill();
        return;
      }
      if (e.key === "F11") {
        e.preventDefault();
        e.stopPropagation();
        toggleFullscreen();
        return;
      }
      if (modalOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeOverlay();
          return;
        }
        e.stopPropagation();
        return;
      }
      const tag = (document.activeElement?.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        e.stopPropagation();
      }
    }, true);

    window.addEventListener("keyup", (e) => {
      if (modalOpen || ["INPUT", "TEXTAREA", "SELECT"].includes((document.activeElement?.tagName || "").toUpperCase())) {
        e.stopPropagation();
      }
    }, true);

    window.addEventListener("keypress", (e) => {
      if (modalOpen || ["INPUT", "TEXTAREA", "SELECT"].includes((document.activeElement?.tagName || "").toUpperCase())) {
        e.stopPropagation();
      }
    }, true);

    let lastConnected = false;
    let lastRunState = window.StsNetBridge.getState().runState || "LOBBY";
    window.StsNetBridge.subscribe((st) => {
      updateHudPill();
      updateAccountStrip();
      if (st.connected && !lastConnected) {
        wakeHudBrief(2600);
      }
      if (st.runState === "IN_RUN" && lastRunState !== "IN_RUN") {
        if (modalOpen) closeOverlay();
        wakeHudBrief(2200);
      }
      lastConnected = st.connected;
      lastRunState = st.runState || "LOBBY";
      if (modalOpen && activeTab === "lobby") renderModal();
    });

    if (window.StsAssetLoader) {
      window.StsAssetLoader.subscribe((st) => {
        const loader = document.getElementById("sts-boot-overlay");
        const fill = document.getElementById("sts-boot-bar-fill");
        const msg = document.getElementById("sts-boot-msg");
        if (fill) fill.style.width = `${st.percent || 0}%`;
        if (msg) msg.textContent = st.message || "";
        if (st.phase === "ready" && loader) {
          loader.classList.add("fade-out");
          setTimeout(() => { loader.style.display = "none"; }, 450);
          wakeHudBrief(2600);
          if (!autoJoinedUrlRoom) {
            autoJoinedUrlRoom = true;
            const roomParam = new URLSearchParams(window.location.search).get("room");
            if (roomParam) {
              window.StsNetBridge.joinRoom(roomParam);
            }
          }
        }
      });
    }
  }

  window.StsUI = {
    openOverlay,
    closeOverlay,
    toggleOverlay,
    renderModal,
    resetHudPosition,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
