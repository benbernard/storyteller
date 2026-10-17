"""Validate a saved audition turn before reusing its audio."""

from __future__ import annotations

import hashlib
import json

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tts_typing import JsonObject
    from pathlib import Path


def cached_turn(
    receipt: Path, audio: Path, *, request: JsonObject, role: str, index: int
) -> JsonObject | None:
    if not (receipt.exists() and audio.exists()):
        return None
    record = json.loads(receipt.read_text())
    if (
        record.get("request") != request
        or record.get("role") != role
        or record.get("turn_index") != index
    ):
        raise ValueError(
            f"Cached turn {index} has different text, voice, or settings. "
            "Use a new audition directory to preserve the earlier result."
        )
    expected_hash = record.get("audio_sha256")
    if (
        expected_hash
        and hashlib.sha256(audio.read_bytes()).hexdigest() != expected_hash
    ):
        raise ValueError(f"Cached turn {index} audio does not match its receipt")
    # Earlier receipts did not carry per-turn hashes. Their requests still have
    # to match exactly; new receipts add the checksum below in the caller.
    return record
