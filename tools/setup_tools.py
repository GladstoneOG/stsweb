#!/usr/bin/env python3
"""
Slay the Spire Web (stsweb) — Local Toolchain Bootstrap
=======================================================
Downloads and verifies cached Vineflower 1.12.0 and Gradle 9.9.2 under
`tools/.cache/`, pinned to Adoptium JDK 21.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
CACHE_DIR = os.path.join(SCRIPT_DIR, ".cache")

JDK21_HOME = os.environ.get(
    "STS_JDK21_HOME",
    r"C:\Program Files\Eclipse Adoptium\jdk-21.0.8.9-hotspot",
)
STS_JAR_PATH = os.environ.get(
    "STS_JAR_PATH",
    r"F:\SteamLibrary\steamapps\common\SlayTheSpire\desktop-1.0.jar",
)

VINEFLOWER_URL = "https://github.com/Vineflower/vineflower/releases/download/1.12.0/vineflower-1.12.0.jar"
VINEFLOWER_JAR = os.path.join(CACHE_DIR, "vineflower-1.12.0.jar")

GRADLE_VERSION = "9.9.2"
GRADLE_URL = f"https://services.gradle.org/distributions/gradle-{GRADLE_VERSION}-bin.zip"
GRADLE_ZIP = os.path.join(CACHE_DIR, f"gradle-{GRADLE_VERSION}-bin.zip")
GRADLE_HOME = os.path.join(CACHE_DIR, f"gradle-{GRADLE_VERSION}")
GRADLE_BIN = os.path.join(GRADLE_HOME, "bin", "gradle.bat" if os.name == "nt" else "gradle")


def download_file(url: str, dest: str) -> None:
    tmp = dest + ".part"
    print(f"[setup] Downloading {url} -> {dest}")
    req = urllib.request.Request(url, headers={"User-Agent": "stsweb-setup/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            out.write(chunk)
            done += len(chunk)
            if total > 0:
                pct = done * 100 // total
                print(f"\r[setup]   {done / 1048576:.1f} / {total / 1048576:.1f} MiB ({pct}%)", end="", flush=True)
        if total > 0:
            print()
    os.replace(tmp, dest)


def main() -> int:
    os.makedirs(CACHE_DIR, exist_ok=True)

    java_exe = os.path.join(JDK21_HOME, "bin", "java.exe" if os.name == "nt" else "java")
    if not os.path.isfile(java_exe):
        print(f"[setup] ERROR: JDK 21 not found at {java_exe}", file=sys.stderr)
        return 1
    print(f"[setup] Verified JDK 21: {java_exe}")

    if not os.path.isfile(STS_JAR_PATH):
        print(f"[setup] ERROR: Slay the Spire JAR not found at {STS_JAR_PATH}", file=sys.stderr)
        return 1
    print(f"[setup] Verified STS JAR: {STS_JAR_PATH} ({os.path.getsize(STS_JAR_PATH) / 1048576:.2f} MiB)")

    if not os.path.isfile(VINEFLOWER_JAR):
        download_file(VINEFLOWER_URL, VINEFLOWER_JAR)
    else:
        print(f"[setup] Cached Vineflower: {VINEFLOWER_JAR}")

    if not os.path.isfile(GRADLE_BIN):
        if not os.path.isfile(GRADLE_ZIP):
            download_file(GRADLE_URL, GRADLE_ZIP)
        extract_tmp = GRADLE_HOME + "_tmp"
        if os.path.isdir(extract_tmp):
            shutil.rmtree(extract_tmp)
        print(f"[setup] Extracting {GRADLE_ZIP}...")
        with zipfile.ZipFile(GRADLE_ZIP, "r") as zf:
            zf.extractall(extract_tmp)
        inner = os.path.join(extract_tmp, f"gradle-{GRADLE_VERSION}")
        if os.path.isdir(GRADLE_HOME):
            shutil.rmtree(GRADLE_HOME)
        shutil.move(inner if os.path.isdir(inner) else extract_tmp, GRADLE_HOME)
        if os.path.isdir(extract_tmp):
            shutil.rmtree(extract_tmp)
    else:
        print(f"[setup] Cached Gradle: {GRADLE_BIN}")

    env = os.environ.copy()
    env["JAVA_HOME"] = JDK21_HOME
    env["PATH"] = os.path.join(JDK21_HOME, "bin") + os.pathsep + env.get("PATH", "")

    print("[setup] Verifying Vineflower...")
    vf_res = subprocess.run([java_exe, "-jar", VINEFLOWER_JAR, "--version"], env=env, capture_output=True, text=True)
    print(vf_res.stdout.strip() or vf_res.stderr.strip())
    if vf_res.returncode != 0:
        print("[setup] ERROR: Vineflower verification failed", file=sys.stderr)
        return vf_res.returncode

    print("[setup] Verifying Gradle...")
    gr_res = subprocess.run([GRADLE_BIN, "--version"], env=env, capture_output=True, text=True)
    print(gr_res.stdout.strip())
    if gr_res.returncode != 0:
        print(gr_res.stderr, file=sys.stderr)
        return gr_res.returncode

    print("[setup] All tools ready.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
