#!/usr/bin/env python3
"""Runs cached Gradle 9.9.2 inside `stsweb/java` pinned to JDK 21."""

from __future__ import annotations

import os
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
JAVA_DIR = os.path.join(PROJECT_DIR, "java")
CACHE_DIR = os.path.join(SCRIPT_DIR, ".cache")

JDK21_HOME = os.environ.get(
    "STS_JDK21_HOME",
    r"C:\Program Files\Eclipse Adoptium\jdk-21.0.8.9-hotspot",
)
GRADLE_BIN = os.path.join(
    CACHE_DIR,
    "gradle-9.9.2",
    "bin",
    "gradle.bat" if os.name == "nt" else "gradle",
)


def main() -> int:
    if not os.path.isfile(GRADLE_BIN):
        print(f"Gradle not found at {GRADLE_BIN}. Run `python tools/setup_tools.py` first.", file=sys.stderr)
        return 1

    env = os.environ.copy()
    env["JAVA_HOME"] = JDK21_HOME
    env["PATH"] = os.path.join(JDK21_HOME, "bin") + os.pathsep + env.get("PATH", "")

    args = sys.argv[1:] or ["tasks"]
    cmd = [GRADLE_BIN, "--no-daemon", *args]
    res = subprocess.run(cmd, cwd=JAVA_DIR, env=env)
    return res.returncode


if __name__ == "__main__":
    raise SystemExit(main())
