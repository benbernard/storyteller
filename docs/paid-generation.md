# ElevenLabs audio generation

This guide covers ElevenLabs speech and OpenAI chapter analysis. For Inworld,
use [Inworld API setup](inworld.md). You need your
own keys and current prices for the models and voices you choose. The example
configuration has zero spending ceilings and cannot generate paid audio until
you configure it. Never copy the demo's synthetic voice ratings into a real book.

## Configure a book

1. Put `OPENAI_API_KEY` and `ELEVENLABS_API_KEY` in your local `.env` using an editor.
2. Copy `tools/audiobooks/examples/fiction.json` to `data/input/my-fiction.json`.
3. Set `fictionId` to the imported story ID. Set real narrator/anonymous voice IDs,
   your analysis model, and current input/output token prices.
4. Set `analysis.maxCallsPerBatch`, `budget.maxCharacters`, and
   `budget.maxEstimatedUsd` to your allowed limits. Set the speech character price
   to cover the chosen voices, model, and any surcharge. Dollar estimates use your
   configured prices; also configure limits in the provider accounts.
5. Choose narration rules. Match the narrator to the main character's gender when
   established by the story. Decide whether the protagonist shares that voice.

```sh
export FICTION_ID=my-book
docker compose run --rm cli configure --file /input/my-fiction.json
docker compose run --rm cli schema --kind config
```

Use one fiction state directory per story and one new batch ID after changing
source, casting, corrections, or generation policy. `FICTION_ID` selects the
Compose mount path; it must match the configuration and imported chapters.

## Audition and save the evidence

Before a full batch, audition a few suitable voices. Create
`data/input/audition.json` with a real voice ID and exact sample text:

```json
{
  "voice": {
    "voiceId": "YOUR_VOICE_ID",
    "settings": {
      "stability": 0.5, "similarity_boost": 0.75,
      "style": 0, "use_speaker_boost": true, "speed": 1
    }
  },
  "text": "The lantern flickered. We should leave before dawn.",
  "model": "eleven_v3"
}
```

```sh
docker compose run --rm cli audition --batch pilot --file /input/audition.json
```

This command spends provider credits within the configured pilot budget. The
result includes `sampleAsset` and an audio path under the selected fiction's
`assets/` directory. Listen to that audio. Add each accepted voice to `pool` in
your input configuration with its settings, source-supported portrayal `tags`,
rating from 0–5, `ratedBy`, notes, `reserveForMajor`, and returned `sampleAsset`.
The engine verifies the saved audition checksum. Re-run `configure` after editing.

Keep a suitable range of voices. A missing compatible pool is a setup error.
Known minor speakers do not silently become the narrator. Narrator and anonymous
voices must differ. Use the same `pilot` batch ID for paid auditions and model
experiments to keep their spending under one ledger.

## Prepare, compare, then generate

Import chapters as described in the import guide, then prepare a small selection:

```sh
docker compose run --rm cli prepare --batch pilot --chapters CHAPTER_ID
```

**Prepare can spend OpenAI analysis credits.** It performs missing analysis and
casting, and previews speech cost without requesting speech. Review uncertain
speakers and casting before rendering. You can supply externally prepared
analysis with `analyze-import`; inspect `schema --kind analysis` first.

For paid model comparisons:

```sh
docker compose run --rm cli experiments --batch pilot --chapters CHAPTER_ID
```

This spends speech credits on four saved trial policies under the pilot ledger.
Listen to the joined files and record your decision in
`policy.listeningEvidence`. Set `policy.selectedAfterListening: true`, reconfigure,
and use a new batch for the chosen policy:

```sh
docker compose run --rm cli configure --file /input/my-fiction.json
docker compose run --rm cli run --batch first-chapter --chapters CHAPTER_ID
docker compose run --rm cli status
docker compose run --rm cli publish --batch first-chapter --edition v3 \
  --title 'My book' --author 'Author'
```

Open Listener and select the published book. Publication verifies assemblies and
does not call a provider. Use `eleven_v3` with scene grouping for multi-voice
requests, or `eleven_flash_v2_5` for separate single-voice requests. Flash rejects
v3 acting tags. Name editions consistently: the `v3` and `flash` names have model
checks. Custom edition names are supported.

For standalone files:

```sh
docker compose run --rm cli export --batch first-chapter --output /exports/my-book-v1
```

The new output directory contains numbered MP3s, an M3U playlist, and a delivery
manifest. It does not contain private cast analysis.

## Resume and repair

Repeat a failed `run` with the same batch ID and inputs. Checked completed assets
are reused. Unknown paid request outcomes retain their budget reservation, so a
timeout cannot silently trigger a second payment. Inspect the saved ledger before
manually resolving an uncertain request. Do not erase ledgers to force a retry.

Locate a reported issue by its original recording and timestamp:

```sh
docker compose run --rm cli locate --assembly ASSEMBLY_HASH --seconds 123
```

A correction file contains the returned `spanId`, a `reason`, and optionally
`speaker`, `renderText`, or `tag`. Record it, then render and publish a new batch:

```sh
docker compose run --rm cli correct --assembly ASSEMBLY_HASH --file /input/correction.json
docker compose run --rm cli run --batch repair-001 --purpose repair --chapters CHAPTER_ID
docker compose run --rm cli publish --batch repair-001 --edition v3 --title 'My book'
```

Repairs preserve the original source, earlier assemblies, and issue timestamps.
Grouping and context can enlarge a repair beyond one line. Resolve an issue after
checking the replacement audio; resolving a report alone does not regenerate it.
