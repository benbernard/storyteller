# Hear Storyteller

The same scene from Dashiell Hammett's *The Maltese Falcon* (1930), Chapter 1,
with a narrator, Sam Spade, Miss Wonderly, and Miles Archer. These recordings were generated for Storyteller with synthetic voices.

| Edition | Listen/download | Length | Voices |
| --- | --- | --- | --- |
| Breeze | [Breeze MP3](breeze.mp3) | 1:16 | Four original synthetic voices designed with Breeze |
| Qwen | [Qwen MP3](qwen.mp3) | 1:16 | The same four synthetic reference recordings |
| Inworld | [Inworld MP3](inworld.mp3) | 1:25 | Blake, Conrad, Wade, and Camille stock voices |

Breeze is the project's preferred local renderer. These recordings let you judge
for yourself. Inworld uses its own stock voices, so this compares usable editions
rather than isolating the speech model as the only variable.

## Play it in Storyteller

After the [README setup](../../README.md), run:

```sh
docker compose run --rm sample
```

Refresh <http://localhost:8080/listen/> and open **The Maltese Falcon — an office
consultation**. Choose Breeze, Qwen, or Inworld in the edition picker. The reader
shows the same source text with each recording's own passage timings. The Android
app sees the editions when connected to that server.

This command installs bundled files without provider access, model downloads, or
an analysis account. Repeating it checks the
installed files. It refuses to overwrite different existing sample data. For a
Node development setup with built packages, `pnpm sample` does the same job.

## Source and rights

Read the [exact excerpt](excerpt.txt). The 214 whitespace-delimited words contain
18 dialogue turns. The original wording is retained; soft line wraps are joined
and paragraph breaks retained. [scene.json](scene.json) records the source URL,
source-file checksum, exact start/end anchors, normalization, speaker spans, and
excerpt checksum.

The text comes from [Project Gutenberg ebook 77600](https://www.gutenberg.org/ebooks/77600/).
The 1930 novel entered the **United States** public domain in 2026, as described
by the [Library of Congress](https://blogs.loc.gov/copyright/2025/12/lifecycle-of-copyright-1930-works-in-the-public-domain/).
This is not a worldwide public-domain determination. The repository license does
not claim ownership of Hammett's text. Check the status where you use it.

First-party sample scripts and documentation use
[PolyForm Noncommercial 1.0.0](../../LICENSE). To the extent the project can grant
rights in the generated recordings and their original arrangement, they are
provided for noncommercial use under those terms. That does not replace provider
or model terms. Breeze and the Breeze-designed references used by Qwen are subject
to the [BreezeBlue research and noncommercial terms](https://huggingface.co/BreezeBlue/Breeze-TTS-2/blob/main/LICENSE).
These illustrative samples acknowledge **Breeze TTS 2 by BreezeBlue**. No model
weights are distributed. Inworld output remains subject to
[Inworld's terms](https://inworld.ai/terms).

## Generation versions

- Breeze: `mlx-community/Breeze-TTS-2-mlx` at
  `3c8829fb7fd335818f085cd2ef49b4100c0e46c8`, MLX 0.32.3 and mlx-audio 0.5.7,
  eight-bit cached-depth inference.
- Qwen: the `qwen-base` model from the pinned Mac catalog, revision
  `a6eb4f68e4b056f1215157bb696209bc82a6db48`.
- Inworld: hosted `inworld-tts-2`, balanced delivery, normalization off, with
  stock voice IDs in [inworld-voices.json](inworld-voices.json).
- Whole-scene review: `mlx-community/whisper-large-v3-turbo` at
  `a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb`.

## What was checked

The three recordings were generated on October 17, 2026 (October 18 UTC). Source hashes,
audio checksums, decodability, duration, complete source-to-passage coverage, and
an independent Whisper large-v3-turbo transcript were checked. Local voices are
new synthetic designs. They were created without cloning a person or imitating
an actor.

These are previews, with automated transcript evidence and **no human listening
rating**. Recognition varies on “o'clock”, “Yeh”, and “two hundred-dollar bills”.
Whisper also omits the interrupted “I'd be—” in the whole Breeze recording and
“oh!” in Inworld. A separate Breeze passage check recovers the false start after
one bounded retake. These flags remain visible in each edition's JSON; they are
not erased or reported as proof of perfect narration. Listen for delivery and
speaker consistency before choosing a renderer for a book.

[manifest.json](manifest.json) pins every audio/edition file. Each edition's JSON
contains its source, speaker analysis, passage timeline, generation provenance,
and audio-bound transcript evidence. The sample installer verifies these files
before exposing them in the listener.

## Generate your own editions

Playing the bundled sample needs only the listener setup. Regenerating it needs
the corresponding [Breeze](../../docs/breeze.md), [Qwen](../../docs/local-generation.md),
or [Inworld](../../docs/inworld.md) runtime. Run commands from the repository root.
The curated speaker spans bypass subscription analysis for this scene only;
normal book generation still needs analysis.

For the local pair, start the Mac API, then design the synthetic references:

```sh
mkdir -p data/sample/voices
cp samples/maltese-falcon/voice-brief.json data/sample/voices/voices.json
node scripts/breeze.mjs design --directory data/sample/voices
```

Listen to those references before using them. Use the generation Python from
your installation, for example `data/mac-tts/venv/bin/python`:

```sh
node scripts/sample.mjs --provider breeze --python data/mac-tts/venv/bin/python
node scripts/sample.mjs --provider qwen --python data/mac-tts/venv/bin/python
```

The commands use one shared cast and the existing Mac API's exclusive GPU lease.
Run them sequentially. Qwen needs its separately installed model; Breeze setup
alone does not download it. The default private credential is
`data/credentials/mac-client.json`. Override it with `--credential PATH`.
Breeze leaves individual passages for review. Set the cache used by your Breeze
installation, run the independent passage reviewer, and inspect
`data/sample/breeze/review-status.json`:

```sh
export HF_HOME="$PWD/data/mac-tts/cache/huggingface"
data/mac-tts/venv/bin/python tools/mac-tts/acting-auditions/generate.py \
  --model chapter-review --output data/sample/breeze \
  --python data/mac-tts/asr-venv/bin/python \
  --credential data/credentials/mac-client.json
```

For a flagged index, put it in `context-review-request.json` as a JSON array of
four-digit strings and repeat with `--model chapter-context-review`. Review the
recording and evidence, then write `review-decisions.json` keyed by index. Each
decision requires the current review file's SHA-256, a reason, and severity
`pass`, `minor`, `major`, or `uncertain`. See the
[review and publication guide](../../docs/breeze.md#generate-review-and-publish).
Do not mark an automated comparison as human listening. After resolving flags:

```sh
data/mac-tts/venv/bin/python tools/mac-tts/acting-auditions/assemble_chapter.py \
  data/sample/breeze data/sample/breeze/state public-sample
```

Major or uncertain passages cannot be exported as accepted audio. Keep originals
when making a retake. The normal Breeze book worker automates these stages for
imported books; this curated sample exposes them for comparison.

For Inworld, store your own `INWORLD_API_KEY` privately as described in its guide.
The command reads it from the process environment or the ignored root `.env`.
The supplied cast file contains public stock voice IDs, not credentials:

```sh
node scripts/sample.mjs --provider inworld --rate 0.025 \
  --voices samples/maltese-falcon/inworld-voices.json
```

`--rate` is USD per **thousand** characters. This example used the published
[TTS-2 on-demand rate](https://inworld.ai/pricing) of $25 per million characters,
checked October 17, 2026. Verify your current plan's price before running.
The sample caps estimated speech spend at $0.50, characters at 5,000, and each
segment at one attempt. The generated preview used about $0.0312 of reserved
speech cost, including an initial whitespace-only request that returned no audio.
The final preparation attaches separators to the preceding turn to avoid that
request. Completed audio is cached; uncertain failures are not silently retried.

After assembling all three editions, retain a whole-scene independent review:

```sh
data/mac-tts/asr-venv/bin/python tools/mac-tts/review_sample.py \
  --credential data/credentials/mac-client.json
```

This uses the already-downloaded Whisper revision and the same GPU lease. Review
the output before exporting. `node scripts/export-sample.mjs` exports only this
scene from `data/sample/{breeze,qwen,inworld}/state`, checks source and audio hashes,
and includes the bound transcript evidence. It does not export credentials,
private paths, source archives, or other books. Regeneration is seed-based within
a pinned runtime. Audio may differ on another machine.
