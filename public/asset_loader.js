// ============================================================================
// Slay the Spire Web — Progressive IndexedDB + STSPK01.gz Asset Loader
// ============================================================================
(function () {
  const DB_NAME = "stsweb_vfs_v1";
  const STORE_NAME = "packs";
  const MAGIC = "STSPK01\0";

  let bootQueue = [];
  let bootTotalFiles = 0;
  let bootReady = false;
  let streamQueue = [];
  let currentBatch = [];

  const listeners = new Set();
  function emitStatus(patch) {
    Object.assign(statusState, patch);
    for (const fn of listeners) {
      try { fn(statusState); } catch (_) {}
    }
  }

  const statusState = {
    phase: "init",
    message: "Checking cached Spire assets...",
    percent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    mountedFiles: 0,
    totalBootFiles: 0,
    actsLoaded: false,
    error: null,
  };

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }

  async function idbGet(db, key) {
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function idbPut(db, key, value) {
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const req = tx.objectStore(STORE_NAME).put(value, key);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      } catch (_) {
        resolve(false);
      }
    });
  }

  async function sha256Hex(buffer) {
    if (!crypto?.subtle) return "";
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const arr = new Uint8Array(digest);
    let hex = "";
    for (let i = 0; i < arr.length; i++) {
      hex += arr[i].toString(16).padStart(2, "0");
    }
    return hex;
  }

  async function fetchChunksParallel(packMeta, onProgress) {
    const urls = packMeta.chunks;
    const parts = new Array(urls.length);
    const loadedPerChunk = new Array(urls.length).fill(0);
    let nextIdx = 0;

    async function worker() {
      while (true) {
        const idx = nextIdx++;
        if (idx >= urls.length) break;
        const resp = await fetch(urls[idx], { cache: "force-cache" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} loading ${urls[idx]}`);

        if (resp.body && resp.body.getReader) {
          const reader = resp.body.getReader();
          const chunks = [];
          let total = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            total += value.byteLength;
            loadedPerChunk[idx] = total;
            const sum = loadedPerChunk.reduce((a, b) => a + b, 0);
            onProgress(sum, packMeta.compressedSize);
          }
          const merged = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) {
            merged.set(c, off);
            off += c.byteLength;
          }
          parts[idx] = merged;
        } else {
          const buf = new Uint8Array(await resp.arrayBuffer());
          loadedPerChunk[idx] = buf.byteLength;
          parts[idx] = buf;
          onProgress(loadedPerChunk.reduce((a, b) => a + b, 0), packMeta.compressedSize);
        }
      }
    }

    const workers = [];
    const concurrency = Math.min(4, urls.length);
    for (let i = 0; i < concurrency; i++) workers.push(worker());
    await Promise.all(workers);

    const totalSize = parts.reduce((acc, p) => acc + p.byteLength, 0);
    const combined = new Uint8Array(totalSize);
    let offset = 0;
    for (const p of parts) {
      combined.set(p, offset);
      offset += p.byteLength;
    }

    if (packMeta.sha256 && crypto?.subtle) {
      const actual = await sha256Hex(combined.buffer);
      if (actual !== packMeta.sha256) {
        throw new Error(`SHA-256 mismatch for ${packMeta.name} (${actual} != ${packMeta.sha256})`);
      }
    }
    return combined;
  }

  async function decompressGzip(gzBytes) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("Browser lacks DecompressionStream('gzip'). Please use a modern Chrome/Edge/Firefox/Safari.");
    }
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([gzBytes]).stream().pipeThrough(ds);
    return await new Response(stream).arrayBuffer();
  }

  function parseStspk01(rawBuffer) {
    const view = new DataView(rawBuffer);
    const bytes = new Uint8Array(rawBuffer);
    const magic = new TextDecoder().decode(bytes.subarray(0, 8));
    if (magic !== MAGIC) {
      throw new Error(`Invalid STSPK01 magic header: ${magic}`);
    }
    const entryCount = view.getUint32(8, true);
    const indexLen = view.getUint32(12, true);
    const indexStart = 16;
    const dataStart = indexStart + indexLen;
    const indexJson = new TextDecoder("utf-8").decode(bytes.subarray(indexStart, dataStart));
    const records = JSON.parse(indexJson);
    if (records.length !== entryCount) {
      throw new Error(`STSPK01 entry count mismatch (${records.length} != ${entryCount})`);
    }
    const queue = new Array(entryCount);
    for (let i = 0; i < entryCount; i++) {
      const rec = records[i];
      const u8 = new Uint8Array(rawBuffer, dataStart + rec[1], rec[2]);
      queue[i] = [rec[0], u8];
    }
    return queue;
  }

  async function loadPack(db, packMeta, isBoot) {
    const label = isBoot ? "Core Spire Pack" : "Acts II-IV Pack";
    const cached = await idbGet(db, packMeta.name);
    if (cached && cached.sha256 === packMeta.sha256 && cached.raw instanceof ArrayBuffer) {
      if (isBoot) {
        emitStatus({
          phase: "mounting",
          message: `Loaded ${label} from IndexedDB cache`,
          percent: 78,
          downloadedBytes: packMeta.compressedSize,
          totalBytes: packMeta.compressedSize,
        });
      }
      return parseStspk01(cached.raw);
    }

    if (isBoot) {
      emitStatus({
        phase: "downloading",
        message: `Downloading ${label} (${(packMeta.compressedSize / 1048576).toFixed(1)} MiB)...`,
        percent: 5,
        downloadedBytes: 0,
        totalBytes: packMeta.compressedSize,
      });
    }

    const gzBytes = await fetchChunksParallel(packMeta, (loaded, total) => {
      if (isBoot) {
        const pct = Math.min(72, Math.round((loaded / Math.max(1, total)) * 67) + 5);
        emitStatus({
          phase: "downloading",
          message: `Downloading ${label}: ${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB`,
          percent: pct,
          downloadedBytes: loaded,
          totalBytes: total,
        });
      }
    });

    if (isBoot) {
      emitStatus({
        phase: "decompressing",
        message: `Decompressing ${label}...`,
        percent: 76,
      });
    }

    const rawBuf = await decompressGzip(gzBytes);
    await idbPut(db, packMeta.name, { sha256: packMeta.sha256, raw: rawBuf, savedAt: Date.now() });
    return parseStspk01(rawBuf);
  }

  // Expose Java/TeaVM VFS queue bridges
  window.__STS_BOOT_TAKE_BATCH = function (maxEntries) {
    currentBatch = bootQueue.splice(0, maxEntries);
    return currentBatch.length;
  };
  window.__STS_BOOT_IS_DONE = function () {
    return bootReady && bootQueue.length === 0;
  };
  window.__STS_STREAM_TAKE_BATCH = function (maxEntries) {
    currentBatch = streamQueue.splice(0, maxEntries);
    return currentBatch.length;
  };
  window.__STS_HAS_STREAM_ENTRIES = function () {
    return streamQueue.length > 0;
  };
  window.__STS_BATCH_PATH = function (i) {
    return currentBatch[i] ? currentBatch[i][0] : "";
  };
  window.__STS_BATCH_BYTES = function (i) {
    const item = currentBatch[i];
    if (!item) return null;
    const u8 = item[1];
    return new Int8Array(u8.buffer, u8.byteOffset, u8.byteLength);
  };
  window.__STS_CLEAR_BATCH = function () {
    currentBatch = [];
  };
  window.__STS_ON_MOUNT_PROGRESS = function (mounted) {
    const total = bootTotalFiles || 1;
    const pct = 78 + Math.min(18, Math.round((mounted / total) * 18));
    emitStatus({
      phase: "mounting",
      message: `Mounting assets (${mounted} / ${total})...`,
      percent: pct,
      mountedFiles: mounted,
      totalBootFiles: total,
    });
  };
  window.__STS_ON_ENGINE_READY = function () {
    emitStatus({
      phase: "ready",
      message: "Spire Ready!",
      percent: 100,
    });
  };

  async function start() {
    try {
      // Non-blocking server epoch query for Daily Climb timer
      fetch("/api/time", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d && d.epochSeconds) window.__STS_EPOCH_SECONDS = d.epochSeconds;
        })
        .catch(() => {});

      emitStatus({ phase: "manifest", message: "Fetching asset manifest...", percent: 2 });
      const manifestResp = await fetch("/assets/manifest.json", { cache: "no-store" });
      if (!manifestResp.ok) throw new Error("Failed to fetch /assets/manifest.json");
      const manifest = await manifestResp.json();
      const db = await openDb();

      const bootEntries = await loadPack(db, manifest.packs.boot, true);
      bootTotalFiles = bootEntries.length;
      bootQueue = bootEntries;
      bootReady = true;
      emitStatus({
        phase: "mounting",
        message: `Initializing FreeType & ${bootTotalFiles} Spire assets...`,
        percent: 80,
        totalBootFiles: bootTotalFiles,
      });

      // Stream Acts II-IV + 1024 portraits in background right after boot
      if (manifest.packs.acts) {
        loadPack(db, manifest.packs.acts, false)
          .then((entries) => {
            streamQueue = entries;
            emitStatus({ actsLoaded: true });
          })
          .catch((err) => console.warn("[stsweb] Background acts pack error:", err));
      }
    } catch (err) {
      console.error("[stsweb] Asset boot failed:", err);
      emitStatus({
        phase: "error",
        message: err?.message || "Failed loading game assets.",
        error: String(err),
      });
    }
  }

  async function clearCache() {
    const db = await openDb();
    if (!db) return;
    await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  window.StsAssetLoader = {
    start,
    clearCache,
    getStatus: () => ({ ...statusState }),
    subscribe: (fn) => {
      listeners.add(fn);
      fn(statusState);
      return () => listeners.delete(fn);
    },
  };
})();
