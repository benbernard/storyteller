#!/usr/bin/env python3
"""Authenticated CLI: credentials stay in a private file, never command arguments."""

import argparse
import json
import sys
import urllib.request
import urllib.error
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("path")
p.add_argument("--credential", default="data/credentials/mac-client.json")
p.add_argument("--json-file")
p.add_argument("--upload")
p.add_argument("--output")
p.add_argument("--method")
args = p.parse_args()
c = json.loads(Path(args.credential).read_text())
if isinstance(c, list):
    c = {"endpoint": "http://127.0.0.1:8788", "token": c[0]["token"]}
data = (
    Path(args.upload or args.json_file).read_bytes()
    if args.upload or args.json_file
    else None
)
req = urllib.request.Request(
    c["endpoint"] + args.path,
    data=data,
    method=args.method,
    headers={
        "Authorization": "Bearer " + c["token"],
        "Content-Type": "audio/wav" if args.upload else "application/json",
    },
)
try:
    with urllib.request.urlopen(req, timeout=1200) as response:
        if args.output:
            with open(args.output, "wb") as f:
                while chunk := response.read(65536):
                    f.write(chunk)
        elif "ndjson" in response.headers.get("Content-Type", ""):
            for line in response:
                sys.stdout.buffer.write(line)
                sys.stdout.buffer.flush()
        else:
            sys.stdout.buffer.write(response.read() + b"\n")
except urllib.error.HTTPError as e:
    print(e.read().decode(), file=sys.stderr)
    raise SystemExit(1)
