#!/usr/bin/env python3
"""Prepare explicit synthetic voice auditions for future local story casting."""

import argparse
from pathlib import Path
from local_book import read, save

VOICES = {
    "anonymous": (
        "A neutral adult voice with a mid-low register, clear calm articulation and a restrained conversational rhythm.",
        ["adult", "neutral"],
    ),
    "male_warm": (
        "An adult man with a warm baritone, smooth resonance and relaxed conversational phrasing.",
        ["adult", "male", "warm"],
    ),
    "male_bright": (
        "A young adult man with a bright tenor and quick, clear conversational phrasing.",
        ["adult", "male", "young", "bright"],
    ),
    "male_rough": (
        "An older adult man with a low gravelly bass and patient deliberate articulation.",
        ["adult", "male", "older", "rough"],
    ),
    "male_dry": (
        "An adult man with a dry mid-pitched voice, crisp consonants and measured matter-of-fact delivery.",
        ["adult", "male", "dry"],
    ),
    "female_warm": (
        "An adult woman with a warm alto, full resonance and steady conversational articulation.",
        ["adult", "female", "warm"],
    ),
    "female_bright": (
        "A young adult woman with a bright soprano, clear diction and lively conversational rhythm.",
        ["adult", "female", "young", "bright"],
    ),
    "female_rough": (
        "An older adult woman with a low smoky contralto and deliberate, grounded phrasing.",
        ["adult", "female", "older", "rough"],
    ),
    "female_cool": (
        "An adult woman with a cool mid-register voice, precise consonants and calm controlled delivery.",
        ["adult", "female", "precise"],
    ),
    "child_boy": (
        "A boy's youthful high voice, clear natural articulation and an unhurried conversational rhythm.",
        ["child", "male", "young"],
    ),
    "child_girl": (
        "A girl's youthful light voice, clear natural articulation and an unhurried conversational rhythm.",
        ["child", "female", "young"],
    ),
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--narrator-cast", required=True)
    parser.add_argument("--directory", required=True)
    args = parser.parse_args()
    directory = Path(args.directory)
    narrator = read(args.narrator_cast)["voices"]["narrator"]
    voices = {
        "narrator": {
            key: narrator[key] for key in ["reference_id", "transcript", "provenance"]
        }
    }
    tags = {"narrator": {"tags": ["narrator"], "reserved": True}}
    for role, (description, labels) in VOICES.items():
        voices[role] = {
            "description": description
            + " Neutral American English. Natural speech without theatrical exaggeration."
        }
        tags[role] = {"tags": labels, "reserved": role == "anonymous"}
    spec = {
        "selection": "Fixed synthetic reference pool for local audiobook casting; preserve each saved waveform and decision.",
        "reference_text": narrator["transcript"],
        "voices": voices,
    }
    if (directory / "cast-spec.json").exists() and read(
        directory / "cast-spec.json"
    ) != spec:
        raise ValueError("Pool specification changed; use a fresh directory")
    save(directory / "cast-spec.json", spec)
    save(directory / "tags.json", tags)
    print(
        "Prepared 12 explicit reference auditions. Render with design_book_cast.py, review, then import with local-admin pool."
    )


if __name__ == "__main__":
    main()
