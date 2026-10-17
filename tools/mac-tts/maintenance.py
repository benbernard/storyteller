#!/usr/bin/env python3
"""Remove expired generated audio and rotate private logs; preserve voices/weights."""

import os
import time
import shutil
from pathlib import Path

root = Path(os.environ.get("MAC_TTS_HOME", str(Path.home() / ".local/share/mac-tts")))
now = time.time()
for path in (root / "audio").glob("*"):
    if path.is_dir() and now - path.stat().st_mtime > 7 * 86400:
        shutil.rmtree(path)
for path in root.glob("*.log"):
    if path.stat().st_size > 10 * 1024 * 1024:
        # Preserve the open file inode for launchd and the controller.
        with path.open("r+b") as f:
            f.seek(-1024 * 1024, 2)
            tail = f.read()
            f.seek(0)
            f.write(tail)
            f.truncate()
