#!/usr/bin/env python3
"""Decompiles desktop-1.0.jar via Vineflower and applies stsweb patches."""

from __future__ import annotations

import os
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def main() -> int:
    for script in ("decompile_sts.py", "patch_sts.py"):
        res = subprocess.run([sys.executable, os.path.join(SCRIPT_DIR, script)])
        if res.returncode != 0:
            return res.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
