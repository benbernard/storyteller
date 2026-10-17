"""Download only pinned model snapshots to the private Hugging Face cache."""

import json
import argparse
from pathlib import Path
from huggingface_hub import snapshot_download

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--all', action='store_true', help='Explicitly download every audition model')
args = parser.parse_args()
retained = set(json.loads((Path(__file__).parent / 'retained-models.json').read_text()))
for repo, revision in json.loads(
    (Path(__file__).parent / "models.lock.json").read_text()
).items():
    if not args.all and repo not in retained:
        continue
    patterns = (
        [
            "config_*.json",
            "codec.pt",
            "llm_posttrain.pt",
            "Qwen2.5-1.5B/*.json",
            "Qwen2.5-1.5B/*.txt",
        ]
        if repo == "FireRedTeam/FireRedTTS2"
        else None
    )
    snapshot_download(repo, revision=revision, allow_patterns=patterns)
    print(f"Ready: {repo}@{revision}", flush=True)
