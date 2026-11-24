#!/usr/bin/env python3
"""
Slay the Spire Web (stsweb) — Asset Extractor & STSPK01 Packager
================================================================
Extracts Slay the Spire assets from desktop-1.0.jar into:
  1. Streamed music files under `public/audio/music/*.ogg` (each 1-6 MiB)
  2. `boot` STSPK01.gz chunked pack (`public/assets/boot.partXX.bin`) — Title, UI,
     Cards, Powers, Relics, Potions, Characters, SFX, English localization, Act 1
  3. `acts` STSPK01.gz chunked pack (`public/assets/acts.partXX.bin`) — Act 2/3/4
     scenes & monsters, 1024 portraits, large relics, achievements, extra locales
  4. `public/assets/manifest.json` with SHA-256 integrity hashes & chunk lists.

All generated files are verified strictly < 18 MiB for Cloudflare Workers Free Plan
(25 MiB per-asset limit).
"""

from __future__ import annotations

import argparse
import glob
import gzip
import hashlib
import io
import json
import os
import struct
import sys
import time
import zipfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
DEFAULT_STS_JAR = os.environ.get(
    "STS_JAR_PATH",
    r"F:\SteamLibrary\steamapps\common\SlayTheSpire\desktop-1.0.jar",
)

PUBLIC_DIR = os.path.join(PROJECT_DIR, "public")
ASSETS_OUT_DIR = os.path.join(PUBLIC_DIR, "assets")
AUDIO_MUSIC_DIR = os.path.join(PUBLIC_DIR, "audio", "music")
UI_ASSETS_DIR = os.path.join(PUBLIC_DIR, "ui-assets")

WEB_UI_ASSET_MAP = {
    "font/Kreon-Bold.ttf": "Kreon-Bold.ttf",
    "font/Kreon-Regular.ttf": "Kreon-Regular.ttf",
    "font/ZillaSlab-RegularItalic.otf": "ZillaSlab-RegularItalic.otf",
    "title/title.jpg": "title-bg.jpg",
    "images/ui/title_logo/eng.png": "logo-eng.png",
    "images/ui/selectBanner.png": "select-banner.png",
    "images/ui/profile/save_panel.png": "save-panel.png",
    "images/ui/event/panel.png": "event-panel.png",
    "images/ui/event/enabledButton.png": "event-btn.png",
    "images/ui/topPanel/bar.png": "top-bar.png",
    "images/ui/topPanel/buttonL.png": "btn-teal.png",
    "images/ui/topPanel/buttonLRed.png": "btn-red.png",
    "images/ui/topPanel/endTurnButton.png": "end-turn-btn.png",
    "images/ui/mainMenu/menu_option_highlight.png": "menu-highlight.png",
    "images/ui/topPanel/panelHeart.png": "icon-heart.png",
    "images/ui/topPanel/panelGoldBag.png": "icon-gold.png",
    "images/ui/topPanel/floor.png": "icon-floor.png",
    "images/ui/topPanel/ascension.png": "icon-ascension.png",
    "images/ui/topPanel/settings.png": "icon-settings.png",
    "images/ui/charSelect/ironcladButton.png": "char-ironclad.png",
    "images/ui/charSelect/silentButton.png": "char-silent.png",
    "images/ui/charSelect/defectButton.png": "char-defect.png",
    "images/ui/charSelect/watcherButton.png": "char-watcher.png",
    "images/ui/cursors/gold2.png": "cursor-gold.png",
}

ARCHIVE_MAGIC = b"STSPK01\x00"
CHUNK_SIZE_LIMIT = 16 * 1024 * 1024      # 16 MiB chunks
VERIFY_MAX_FILE_SIZE = 18 * 1024 * 1024  # Strictly < 18 MiB (< 25 MiB CF cap)

SKIP_PREFIXES = (
    "META-INF/",
    "com/",
    "org/",
    "net/",
    "javazoom/",
    "de/",
    "win-x64/",
    "win-x86/",
    "linux/",
    "darwin/",
    "font/zhs/",
    "font/zht/",
    "font/jpn/",
    "font/kor/",
    "oldCards/",
    "images/1024PortraitsBeta/",
)

ROOT_KEEP_FILES = {
    "build.properties",
    "default.fnt",
    "default.png",
    "particle.png",
    "pre_particle.png",
    "splash.jpg",
    "uiskin.atlas",
    "uiskin.json",
    "uiskin.png",
}

BOOT_PREFIXES = (
    "font/",
    "shaders/",
    "localization/eng/",
    "title/",
    "cardui/",
    "cards/",
    "powers/",
    "vfx/",
    "orbs/",
    "bottomScene/",
    "images/ui/",
    "images/relics/",
    "images/potion/",
    "images/npcs/",
    "images/characters/",
    "images/monsters/theBottom/",
    "images/events/",
    "images/scenes/",
    "images/cards/",
    "images/tinyCards/",
    "images/vfx/",
    "images/blights/",
    "images/orbs/",
    "audio/sound/",
)

BOOT_EXACT = {
    "images/megaCrit.png",
    "images/blank.png",
    "images/pack.json",
    "images/debugHitbox.png",
    "images/whiteScreen.png",
    "images/whiteSquare32.png",
    "images/dottedSquare.png",
}


def classify_entry(name: str) -> str:
    if name.endswith("/") or name.endswith(".class"):
        return "skip"
    if any(name.startswith(p) for p in SKIP_PREFIXES):
        return "skip"
    if "/" not in name:
        return "boot" if name in ROOT_KEEP_FILES else "skip"
    if name.startswith("audio/music/"):
        return "music"
    if name in BOOT_EXACT or any(name.startswith(p) for p in BOOT_PREFIXES):
        return "boot"
    return "acts"


def build_stspk01(entries: list[tuple[str, bytes]]) -> bytes:
    """Pack (path, bytes) tuples into STSPK01 format."""
    index_records: list[list] = []
    payload_parts: list[bytes] = []
    offset = 0
    for path, raw in entries:
        index_records.append([path, offset, len(raw)])
        payload_parts.append(raw)
        offset += len(raw)

    index_bytes = json.dumps(index_records, separators=(",", ":")).encode("utf-8")
    header = ARCHIVE_MAGIC + struct.pack("<II", len(entries), len(index_bytes))
    return header + index_bytes + b"".join(payload_parts)


def write_pack(prefix: str, entries: list[tuple[str, bytes]]) -> dict:
    for stale in glob.glob(os.path.join(ASSETS_OUT_DIR, f"{prefix}.part*.bin")):
        os.remove(stale)

    uncompressed = build_stspk01(entries)
    compressed = gzip.compress(uncompressed, compresslevel=6, mtime=0)
    sha256_hex = hashlib.sha256(compressed).hexdigest()

    parts: list[str] = []
    total_len = len(compressed)
    for idx, off in enumerate(range(0, total_len, CHUNK_SIZE_LIMIT)):
        part_name = f"{prefix}.part{idx:02d}.bin"
        part_path = os.path.join(ASSETS_OUT_DIR, part_name)
        chunk = compressed[off : off + CHUNK_SIZE_LIMIT]
        with open(part_path, "wb") as f:
            f.write(chunk)
        parts.append(f"/assets/{part_name}")
        print(f"  [CHUNK] {part_name}: {len(chunk):>10,} B ({len(chunk) / 1048576:.2f} MiB)")

    print(
        f"[PACK:{prefix}] files={len(entries)} raw={len(uncompressed) / 1048576:.2f} MiB "
        f"-> gz={total_len / 1048576:.2f} MiB ({len(parts)} chunks)"
    )
    return {
        "name": prefix,
        "sha256": sha256_hex,
        "compressedSize": total_len,
        "uncompressedSize": len(uncompressed),
        "fileCount": len(entries),
        "chunkSizeLimit": CHUNK_SIZE_LIMIT,
        "chunks": parts,
    }


def extract_web_ui_assets(zf: zipfile.ZipFile) -> int:
    from PIL import Image

    os.makedirs(UI_ASSETS_DIR, exist_ok=True)
    extracted = 0
    for jar_path, out_name in WEB_UI_ASSET_MAP.items():
        data = zf.read(jar_path)
        out_path = os.path.join(UI_ASSETS_DIR, out_name)
        if out_name == "title-bg.jpg":
            with Image.open(io.BytesIO(data)) as im:
                # Crop interior of title/title.jpg jpg/sky (2..1921, 2..1470), avoiding black atlas border
                cropped = im.crop((4, 4, 1920, 1468)).convert("RGB")
                cropped.save(out_path, format="JPEG", quality=92, optimize=True)
        else:
            with open(out_path, "wb") as uf:
                uf.write(data)
        extracted += 1
    print(f"[assets] Extracted {extracted} authentic STS UI fonts/textures to {UI_ASSETS_DIR}.")
    return extracted


def main() -> int:
    parser = argparse.ArgumentParser(description="Package Slay the Spire assets for stsweb.")
    parser.add_argument("--jar", default=DEFAULT_STS_JAR, help="Path to desktop-1.0.jar")
    parser.add_argument("--ui-only", action="store_true", help="Only extract public/ui-assets/ (fast)")
    args = parser.parse_args()

    if not os.path.isfile(args.jar):
        print(f"[assets] ERROR: JAR not found at {args.jar}", file=sys.stderr)
        return 1

    if args.ui_only:
        print(f"[assets] Extracting web UI assets from {args.jar}...")
        with zipfile.ZipFile(args.jar, "r") as zf:
            extract_web_ui_assets(zf)
        return 0

    os.makedirs(ASSETS_OUT_DIR, exist_ok=True)
    os.makedirs(AUDIO_MUSIC_DIR, exist_ok=True)

    boot_entries: list[tuple[str, bytes]] = []
    acts_entries: list[tuple[str, bytes]] = []
    music_files: list[str] = []
    skipped_count = 0

    print(f"[assets] Reading {args.jar}...")
    with zipfile.ZipFile(args.jar, "r") as zf:
        extract_web_ui_assets(zf)
        for info in zf.infolist():
            kind = classify_entry(info.filename)
            if kind == "skip":
                skipped_count += 1
                continue
            data = zf.read(info.filename)
            if kind == "music":
                rel_music = info.filename[len("audio/music/") :]
                out_path = os.path.join(AUDIO_MUSIC_DIR, rel_music)
                os.makedirs(os.path.dirname(out_path), exist_ok=True)
                with open(out_path, "wb") as mf:
                    mf.write(data)
                music_files.append(f"/audio/music/{rel_music}")
            elif kind == "boot":
                boot_entries.append((info.filename, data))
            else:
                acts_entries.append((info.filename, data))

    boot_entries.sort(key=lambda item: item[0])
    acts_entries.sort(key=lambda item: item[0])
    music_files.sort()

    print(
        f"[assets] Classified: boot={len(boot_entries)}, acts={len(acts_entries)}, "
        f"music={len(music_files)}, skipped={skipped_count}"
    )

    boot_meta = write_pack("boot", boot_entries)
    acts_meta = write_pack("acts", acts_entries)

    version_hash = hashlib.sha256(
        (boot_meta["sha256"] + ":" + acts_meta["sha256"]).encode("utf-8")
    ).hexdigest()[:12]

    manifest = {
        "format": "STSPK01",
        "version": version_hash,
        "generatedAt": int(time.time()),
        "packs": {
            "boot": boot_meta,
            "acts": acts_meta,
        },
        "musicCount": len(music_files),
        "musicFiles": music_files,
    }

    manifest_path = os.path.join(ASSETS_OUT_DIR, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as mf:
        json.dump(manifest, mf, indent=2)

    # Verify every output file size under public/assets and public/audio
    max_seen = 0
    checked = 0
    for root_dir in (ASSETS_OUT_DIR, os.path.join(PUBLIC_DIR, "audio")):
        for dp, _, fns in os.walk(root_dir):
            for fn in fns:
                full = os.path.join(dp, fn)
                sz = os.path.getsize(full)
                checked += 1
                if sz > max_seen:
                    max_seen = sz
                if sz >= VERIFY_MAX_FILE_SIZE:
                    raise RuntimeError(f"Asset exceeds 18 MiB limit: {full} ({sz:,} B)")

    print(
        f"[assets] Manifest written ({manifest_path}), version={version_hash}. "
        f"Verified {checked} files (max={max_seen / 1048576:.2f} MiB < 18 MiB)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
