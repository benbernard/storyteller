#!/usr/bin/env python3
"""Prepare explicit local retakes in a new batch while preserving original audio."""

from __future__ import annotations

import argparse
import copy
import shutil
from pathlib import Path

from local_book import digest, read, save
from review_local_book import validate_segment

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tts_typing import JsonObject
    from collections.abc import Sequence


def prepare_retakes(
    source: str | Path, target: str | Path, selections: Sequence[dict[str, str]]
) -> JsonObject:
    source, target = Path(source), Path(target)
    if target.exists():
        raise ValueError("Retake directory must be new")
    if not 1 <= len(selections) <= 64:
        raise ValueError("Choose between one and 64 explicit retakes")
    original = read(source / "plan.json")
    if original["cast"]["model"] != "chatterbox":
        raise ValueError("This retake policy supports expressive Chatterbox only")
    plan = copy.deepcopy(original)
    chosen = {}
    for selection in selections:
        if (
            set(selection) != {"segment_uid", "reason"}
            or not selection["reason"].strip()
        ):
            raise ValueError(
                "Each selection requires segment_uid and an inspection reason"
            )
        if selection["segment_uid"] in chosen:
            raise ValueError("Duplicate retake selection")
        chosen[selection["segment_uid"]] = selection["reason"]
    known = {s["uid"] for c in original["chapters"] for s in c["segments"]}
    if chosen.keys() - known:
        raise ValueError("Unknown segment selection")
    # Validate every source artifact before creating a partial target batch.
    for chapter in original["chapters"]:
        for segment in chapter["segments"]:
            folder = source / "segments" / segment["fingerprint"]
            validate_segment(
                original,
                chapter,
                segment,
                read(folder / "receipt.json"),
                (folder / "audio.wav").read_bytes(),
            )
    for role, voice in original["cast"]["voices"].items():
        if (
            digest((source / "references" / role / "reference.wav").read_bytes())
            != voice["sha256"]
        ):
            raise ValueError("Reference hash mismatch")
    target.mkdir(parents=True, mode=0o700)
    shutil.copytree(source / "references", target / "references")
    save(target / "cast.json", plan["cast"])
    changes = []
    for chapter in plan["chapters"]:
        for segment in chapter["segments"]:
            old_uid, old_key = segment["uid"], segment["fingerprint"]
            if old_uid in chosen:
                # The approved L3 restrained retry controls; retain exact text/reference.
                segment["request"].update(
                    seed=segment["request"]["seed"] + 1000,
                    temperature=0.7,
                    exaggeration=0.4,
                    cfg_weight=0.65,
                )
                voice = plan["cast"]["voices"][segment["role"]]
                segment["fingerprint"] = digest(
                    {
                        "request": segment["request"],
                        "reference_sha256": voice["sha256"],
                        "model": plan["cast"]["model"],
                        "revision": plan["cast"]["revision"],
                    }
                )
                segment["uid"] = digest(
                    {
                        "chapter": chapter["chapterId"],
                        "spans": segment["spans"],
                        "asset": segment["fingerprint"],
                    }
                )
                changes.append(
                    {
                        "original_uid": old_uid,
                        "new_uid": segment["uid"],
                        "original_asset": old_key,
                        "new_asset": segment["fingerprint"],
                        "reason": chosen[old_uid],
                    }
                )
            else:
                folder = target / "segments" / old_key
                folder.mkdir(parents=True)
                for name in ("audio.wav", "receipt.json"):
                    # Copies avoid sharing mutable inode contents between archived batches.
                    shutil.copy2(source / "segments" / old_key / name, folder / name)
    plan["parentPlan"] = digest(original)
    plan["retakes"] = changes
    save(target / "plan.json", plan)
    save(
        target / "retake-provenance.json",
        {
            "parentDirectory": str(source.resolve()),
            "parentPlan": digest(original),
            "plan": digest(plan),
            "changes": changes,
            "providerCredits": 0,
        },
    )
    return plan


def select_retakes(
    source: str | Path,
    candidate: str | Path,
    target: str | Path,
    accepted: Sequence[str],
) -> JsonObject:
    """Compose reviewed choices without modifying either generation attempt."""
    source, candidate, target = Path(source), Path(candidate), Path(target)
    if target.exists():
        raise ValueError("Selection directory must be new")
    original, retry = read(source / "plan.json"), read(candidate / "plan.json")
    if retry["parentPlan"] != digest(original) or retry["cast"] != original["cast"]:
        raise ValueError("Retake parent or cast mismatch")
    changes = {r["original_uid"]: r for r in retry["retakes"]}
    if len(accepted) != len(set(accepted)) or set(accepted) - changes.keys():
        raise ValueError("Unknown or duplicate accepted retake")
    if len(original["chapters"]) != len(retry["chapters"]):
        raise ValueError("Retake chapter coverage differs")
    plan, artifacts = copy.deepcopy(original), []
    for chapter, retry_chapter in zip(plan["chapters"], retry["chapters"]):
        if chapter["chapterId"] != retry_chapter["chapterId"] or len(
            chapter["segments"]
        ) != len(retry_chapter["segments"]):
            raise ValueError("Retake segment coverage differs")
        for i, (segment, replacement) in enumerate(
            zip(chapter["segments"], retry_chapter["segments"])
        ):
            if any(segment[k] != replacement[k] for k in ("text", "role", "spans")):
                raise ValueError("Retake source or speaker differs")
            accepted_here = segment["uid"] in accepted
            if accepted_here:
                if replacement["uid"] != changes[segment["uid"]]["new_uid"]:
                    raise ValueError("Retake selection identity mismatch")
                chapter["segments"][i] = copy.deepcopy(replacement)
            selected = chapter["segments"][i]
            origin = candidate if accepted_here else source
            origin_plan = retry if accepted_here else original
            folder = origin / "segments" / selected["fingerprint"]
            validate_segment(
                origin_plan,
                chapter,
                selected,
                read(folder / "receipt.json"),
                (folder / "audio.wav").read_bytes(),
            )
            artifacts.append((selected, origin))
    model = read(candidate / "runtime.json")["model"]
    if (
        model["id"] != plan["cast"]["model"]
        or model["revision"] != plan["cast"]["revision"]
    ):
        raise ValueError("Rendered model differs from cast")
    for role, voice in original["cast"]["voices"].items():
        for origin in (source, candidate):
            if (
                digest((origin / "references" / role / "reference.wav").read_bytes())
                != voice["sha256"]
            ):
                raise ValueError("Reference hash mismatch")
    target.mkdir(parents=True, mode=0o700)
    shutil.copytree(source / "references", target / "references")
    save(target / "cast.json", plan["cast"])
    for segment, origin in artifacts:
        folder = target / "segments" / segment["fingerprint"]
        folder.mkdir(parents=True)
        for name in ("audio.wav", "receipt.json"):
            shutil.copy2(
                origin / "segments" / segment["fingerprint"] / name, folder / name
            )
        review = origin / "review/segments" / (segment["fingerprint"] + ".json")
        if review.exists():
            dest = target / "review/segments" / review.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(review, dest)
    plan["parentPlan"], plan["attemptPlan"] = digest(original), digest(retry)
    plan["retakes"] = [changes[uid] for uid in accepted]
    save(target / "plan.json", plan)
    save(
        target / "runtime.json",
        {
            "plan": digest(plan),
            "model": model,
            "composedFromPlans": [digest(original), digest(retry)],
            "verification": "Selected source, request, job, WAV and duration receipts verified before composition",
        },
    )
    save(
        target / "retake-provenance.json",
        {
            "parentDirectory": str(source.resolve()),
            "attemptDirectory": str(candidate.resolve()),
            "accepted": list(accepted),
            "rejected": sorted(changes.keys() - set(accepted)),
            "plan": digest(plan),
            "providerCredits": 0,
        },
    )
    return plan


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source", required=True)
    p.add_argument("--target", required=True)
    p.add_argument("--selection", required=True)
    p.add_argument(
        "--candidate",
        help="Compose completed retakes; selection contains accepted original segment UIDs",
    )
    a = p.parse_args()
    if a.candidate:
        plan = select_retakes(a.source, a.candidate, a.target, read(a.selection))
    else:
        plan = prepare_retakes(a.source, a.target, read(a.selection))
    print("Prepared", len(plan["retakes"]), "retakes; original audio retained")


if __name__ == "__main__":
    main()
