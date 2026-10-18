#!/usr/bin/env python3
"""Adapt reviewed trial receipts to the normal local audiobook assembly contract."""
from __future__ import annotations

import json
from pathlib import Path
import sys

from render_chapter import digest as file_digest


def reviewed_issue(name: str, review_hash: str, approval: object, draft: bool) -> dict[str, str] | None:
    if not isinstance(approval, dict) or approval.get("reviewSha256") != review_hash:
        raise ValueError(f"Passage {name} needs an evidence-backed review decision")
    reason, severity = approval.get("reason"), approval.get("severity", "pass")
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError("Review decision needs a reason")
    if severity not in {"pass", "minor", "major", "uncertain"}:
        raise ValueError("Unknown audio review severity")
    if severity in {"major", "uncertain"} and not draft:
        raise ValueError(f"Passage {name} has an unresolved major issue; assemble only as a draft")
    return None if severity == "pass" else {"index": name, "severity": str(severity), "reason": reason}


def main() -> None:
    import soundfile as sf
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from local_book import assemble, digest, read, save

    root, state, batch = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    draft = '--draft' in sys.argv[4:]
    issues: list[dict[str, str]] = []
    plan = read(root / "plan.json")
    phase = read(root / "phase.json")["phase"]
    plan["policy"]["model"] = "breeze-qwen-hybrid" if phase == "hybrid" else "breeze-tts-2"
    plan["actingDirections"] = read(root / "directions.json")
    plan["breezeModel"] = read(root / "model.json")
    plan["trialPhase"] = phase
    plan["retainedAuthorModel"] = "breeze-tts-2" if phase == "breeze-full" else "qwen-base"
    destination = root / "assembly-input"
    for index, segment in enumerate(plan["chapters"][0]["segments"]):
        name = f"{index:04d}"
        receipt_path = root / "segments" / (name + ".json")
        receipt = read(receipt_path)
        audio_path = receipt_path.with_suffix(".wav")
        if receipt["uid"] != segment["uid"] or receipt["text"] != segment["text"] or receipt["sha256"] != file_digest(audio_path):
            raise ValueError("Trial receipt does not match the chapter")
        if receipt["model"] == "breeze-tts-2":
            review_path = root / "review" / (name + ".json")
            review = read(review_path)
            if review["receiptSha256"] != file_digest(receipt_path):
                raise ValueError("Audio review is stale")
            if review["needsInspection"]:
                approval = read(root / "review-decisions.json").get(name)
                issue = reviewed_issue(name, file_digest(review_path), approval, draft)
                if issue:
                    issues.append(issue)
        segment["request"] = {"text": segment["text"], "model": receipt["model"],
            "referenceSha256": receipt["referenceSha256"], "instruction": receipt["instruction"],
            "trialReceiptSha256": file_digest(receipt_path)}
        segment["fingerprint"] = digest(segment["request"])
        folder = destination / "segments" / segment["fingerprint"]
        folder.mkdir(parents=True, exist_ok=True)
        audio, rate = sf.read(audio_path, dtype="float32")
        if rate != 24000 or audio.ndim != 1:
            raise ValueError("Assembly requires mono 24 kHz audio")
        sf.write(folder / "audio.wav", audio, rate, subtype="FLOAT")
        save(folder / "receipt.json", {"request": segment["request"], "fingerprint": segment["fingerprint"],
            "wav_sha256": file_digest(folder / "audio.wav")})
    plan["quality"] = {"status": "blocked" if any(i["severity"] in {"major", "uncertain"} for i in issues)
                       else "provisional" if issues else "reviewed", "issues": issues}
    save(destination / "plan.json", plan)
    save(destination / "runtime.json", {"plan": digest(plan)})
    assemble(state, destination, batch)
    print(json.dumps({"edition": "breeze-hybrid" if phase == "hybrid" else "breeze", "batch": batch}))


if __name__ == "__main__":
    main()
