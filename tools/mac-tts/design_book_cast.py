#!/usr/bin/env python3
"""Create synthetic supporting voices from an explicit private cast specification."""

import argparse
from pathlib import Path
from local_book import API, read, save, digest


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--directory", required=True)
    p.add_argument("--credential", default="data/credentials/mac-client.json")
    a = p.parse_args()
    root = Path(a.directory)
    spec = read(root / "cast-spec.json")
    api = API(a.credential)
    health = api.call("/health")
    assert not health["active"] and not health["queued"], "Mac busy"
    models = api.call("/v1/models")["models"]
    cast = {
        "model": "qwen-base",
        "revision": next(m["revision"] for m in models if m["id"] == "qwen-base"),
        "voices": {},
        "selection": spec["selection"],
    }
    api.wait(api.call("/v1/switch", {"model": "qwen-design"}))
    try:
        for i, (role, voice) in enumerate(spec["voices"].items()):
            folder = root / "references" / role
            folder.mkdir(parents=True, exist_ok=True)
            receipt = folder / "voice.json"
            if receipt.exists():
                value = read(receipt)
                assert value["spec"] == voice, "Cast specification changed"
                assert value["sha256"] == digest(
                    (folder / "reference.wav").read_bytes()
                )
            elif "reference_id" in voice:
                wav = api.call("/v1/references/" + voice["reference_id"], raw=True)
                (folder / "reference.wav").write_bytes(wav)
                value = {**voice, "sha256": digest(wav), "spec": voice}
                save(receipt, value)
            else:
                request = {
                    "text": spec["reference_text"],
                    "instruct": voice["description"],
                    "language": "English",
                    "seed": 1800 + i,
                    "temperature": 0.75,
                    "max_tokens": 512,
                }
                pending = folder / "pending.json"
                if pending.exists():
                    saved = read(pending)
                    assert saved["request"] == request
                    job = api.call("/v1/jobs/" + saved["job"]["id"])
                else:
                    job = api.call(
                        "/v1/jobs", {"model": "qwen-design", "input": request}
                    )
                    save(pending, {"request": request, "job": job})
                job = api.wait(job)
                wav = api.call("/v1/jobs/" + job["id"] + "/audio", raw=True)
                (folder / "reference.wav").write_bytes(wav)
                uploaded = api.call("/v1/references", upload=wav)
                value = {
                    "reference_id": uploaded["id"],
                    "transcript": spec["reference_text"],
                    "sha256": digest(wav),
                    "spec": voice,
                    "request": request,
                    "job": job,
                    "provenance": "Local Qwen VoiceDesign synthetic reference",
                }
                save(receipt, value)
            cast["voices"][role] = value
            save(root / "cast.json", cast)
            print("Reference ready:", role, flush=True)
    finally:
        api.call("/v1/stop", {})


if __name__ == "__main__":
    main()
