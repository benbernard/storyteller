#!/usr/bin/env python3
"""Generate a pinned audition set while holding the local production GPU lease."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import urllib.request
import uuid

HERE = Path(__file__).resolve().parent


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=['breeze-design', 'breeze-chapter', 'breeze-benchmark', 'chapter-review', 'chapter-context-review'], required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--credential", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--scene", type=Path, help="Explicit experimental scene; originals are retained")
    args = parser.parse_args()

    def interrupted(signum: int, frame: object) -> None:
        raise KeyboardInterrupt("Generation interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    credential = json.loads(args.credential.read_text())
    if isinstance(credential, list):
        credential = {"endpoint": "http://127.0.0.1:8788", "token": credential[0]["token"]}
    owner = str(uuid.uuid4())

    def call(path: str, payload: dict[str, str | int] | None = None) -> dict[str, object]:
        request = urllib.request.Request(
            credential["endpoint"] + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Authorization": "Bearer " + credential["token"],
                     "Content-Type": "application/json", "X-Worker-Lease": owner},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    # The service rejects acquisition if the audiobook batch owns the GPU,
    # even in the gap between two passages. Never steal or expire its lease.
    call("/v1/lease", {"owner": owner, "seconds": 120})
    process: subprocess.Popen[bytes] | None = None
    try:
        status = call("/v1/status")
        if status.get("active") or status.get("queued"):
            raise RuntimeError("Production work is active; refusing to unload it")
        call("/v1/stop", {})
        args.output.mkdir(parents=True, exist_ok=True)
        environment = dict(os.environ, AUDITION_LEASE_OWNER=owner)
        if args.scene:
            environment["AUDITION_SCENE"] = str(args.scene.resolve())
        scripts = {"breeze-design": "design_breeze.py", "breeze-chapter": "render_chapter.py",
                   "breeze-benchmark": "benchmark_breeze.py", "chapter-review": "review_chapter.py",
                   "chapter-context-review": "review_chapter_context.py"}
        script = [str(HERE / scripts[args.model]), str(args.output.resolve())]
        process = subprocess.Popen(
            [str(args.python), *script],
            env=environment,
        )
        while process.poll() is None:
            call("/v1/lease", {"owner": owner, "seconds": 120})
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                pass
        if process.returncode:
            raise SystemExit(process.returncode)
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        call("/v1/lease/release", {"owner": owner})


if __name__ == "__main__":
    main()
