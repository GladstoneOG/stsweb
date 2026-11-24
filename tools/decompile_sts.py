#!/usr/bin/env python3
"""
Slay the Spire Web (stsweb) — Filtered JAR Extractor & Vineflower Decompiler
===========================================================================
1. Filters `desktop-1.0.jar` into `tools/.cache/sts-filtered.jar` keeping only:
     - com/esotericsoftware/spine/**
     - de/robojumper/ststwitch/**
     - com/megacrit/cardcrawl/** (minus desktop/steam/discord/gog/ea/ms/wegame/steelseries)
2. Decompiles via Vineflower 1.12.0 (pinned to JDK 21) into `java/core/src/main/java`.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import zipfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
CACHE_DIR = os.path.join(SCRIPT_DIR, ".cache")
CORE_SRC_DIR = os.path.join(PROJECT_DIR, "java", "core", "src", "main", "java")

JDK21_HOME = os.environ.get(
    "STS_JDK21_HOME",
    r"C:\Program Files\Eclipse Adoptium\jdk-21.0.8.9-hotspot",
)
STS_JAR_PATH = os.environ.get(
    "STS_JAR_PATH",
    r"F:\SteamLibrary\steamapps\common\SlayTheSpire\desktop-1.0.jar",
)
VINEFLOWER_JAR = os.path.join(CACHE_DIR, "vineflower-1.12.0.jar")
FILTERED_JAR = os.path.join(CACHE_DIR, "sts-filtered.jar")

INCLUDE_PREFIXES = (
    "com/esotericsoftware/spine/",
    "de/robojumper/ststwitch/",
    "com/megacrit/cardcrawl/",
)

EXCLUDE_PREFIXES = (
    "com/megacrit/cardcrawl/desktop/",
    "com/megacrit/cardcrawl/integrations/steam/",
    "com/megacrit/cardcrawl/integrations/discord/",
    "com/megacrit/cardcrawl/integrations/ea/",
    "com/megacrit/cardcrawl/integrations/gog/",
    "com/megacrit/cardcrawl/integrations/microsoft/",
    "com/megacrit/cardcrawl/integrations/wegame/",
    "com/megacrit/cardcrawl/integrations/SteelSeries",
    "com/megacrit/cardcrawl/helpers/steamInput/",
)


def should_include(name: str) -> bool:
    if not name.endswith(".class"):
        return False
    if not any(name.startswith(p) for p in INCLUDE_PREFIXES):
        return False
    if any(name.startswith(p) for p in EXCLUDE_PREFIXES):
        return False
    return True


def build_filtered_jar(src_jar: str, out_jar: str) -> int:
    os.makedirs(os.path.dirname(out_jar), exist_ok=True)
    count = 0
    with zipfile.ZipFile(src_jar, "r") as zin, zipfile.ZipFile(
        out_jar, "w", compression=zipfile.ZIP_DEFLATED
    ) as zout:
        for info in zin.infolist():
            if should_include(info.filename):
                zout.writestr(info.filename, zin.read(info.filename))
                count += 1
    return count


def clean_decompiled_dirs() -> None:
    for rel in (
        "com/esotericsoftware",
        "de",
        "com/megacrit/cardcrawl",
    ):
        target = os.path.join(CORE_SRC_DIR, rel)
        if not os.path.isdir(target):
            continue
        if rel == "com/megacrit/cardcrawl":
            for child in os.listdir(target):
                if child in ("coop", "web"):
                    continue
                child_path = os.path.join(target, child)
                if os.path.isdir(child_path):
                    shutil.rmtree(child_path)
                else:
                    os.remove(child_path)
        else:
            shutil.rmtree(target)


def main() -> int:
    parser = argparse.ArgumentParser(description="Filter desktop-1.0.jar and decompile via Vineflower.")
    parser.add_argument("--jar", default=STS_JAR_PATH)
    parser.add_argument("--skip-clean", action="store_true")
    args = parser.parse_args()

    java_exe = os.path.join(JDK21_HOME, "bin", "java.exe" if os.name == "nt" else "java")
    if not os.path.isfile(java_exe):
        print(f"JDK 21 not found: {java_exe}", file=sys.stderr)
        return 1
    if not os.path.isfile(VINEFLOWER_JAR):
        print(f"Vineflower not found: {VINEFLOWER_JAR}. Run tools/setup_tools.py first.", file=sys.stderr)
        return 1
    if not os.path.isfile(args.jar):
        print(f"STS JAR not found: {args.jar}", file=sys.stderr)
        return 1

    print(f"[decompile] Filtering {args.jar} -> {FILTERED_JAR}...")
    class_count = build_filtered_jar(args.jar, FILTERED_JAR)
    print(f"[decompile] Filtered {class_count} .class entries.")

    os.makedirs(CORE_SRC_DIR, exist_ok=True)
    if not args.skip_clean:
        clean_decompiled_dirs()

    print(f"[decompile] Running Vineflower 1.12.0 -> {CORE_SRC_DIR}...")
    cmd = [
        java_exe,
        "-Xmx4g",
        "-jar",
        VINEFLOWER_JAR,
        "-dgs=1",
        "-asc=1",
        "-rsy=1",
        f"-e={args.jar}",
        FILTERED_JAR,
        CORE_SRC_DIR,
    ]
    res = subprocess.run(cmd)
    if res.returncode != 0:
        print(f"[decompile] ERROR: Vineflower exited with {res.returncode}", file=sys.stderr)
        return res.returncode

    java_files = 0
    for _, _, fns in os.walk(CORE_SRC_DIR):
        java_files += sum(1 for fn in fns if fn.endswith(".java"))
    print(f"[decompile] Done. Total Java source files in core: {java_files}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
