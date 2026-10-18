# Qwen speech on Apple Silicon

For the recommended local renderer, start with [Breeze setup](breeze.md). This
guide covers Qwen and its automatic follow worker.


Qwen speech generation runs on your Mac. Chapter speaker analysis uses your own
Codex subscription by default; API analysis is a separate opt-in with a dollar
budget. Local speech itself does not consume speech-provider credits.

The recommended first setup runs the listener in Docker and the speech API and
queue worker on the same Mac. Keep the Mac awake while generating. The worker and
Docker listener share the repository's `data/` directory. Separate-host setups
need shared state and a private tunnel; do not expose the speech API publicly.

## Install the tools

Install Node.js 22.13+, the pinned pnpm 10.33.0, Python 3.11+, `uv`, FFmpeg,
`sox`, and `espeak-ng`. On a Homebrew Mac:

```sh
brew install node python uv ffmpeg sox espeak-ng
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm -C tools/audiobooks install --frozen-lockfile
pnpm -C tools/royal-road install --frozen-lockfile
pnpm -C tools/mac-tts install --frozen-lockfile
pnpm run build
node scripts/setup.mjs
node scripts/setup-mac.mjs
```

If your Node distribution omits Corepack, install Corepack first using its
[installation instructions](https://github.com/nodejs/corepack#manual-installs).
The Mac setup syncs isolated Python 3.12 environments from committed locks under
`data/mac-tts/`. Models download from pinned revisions on first load. Allow several
tens of GB of storage and enough unified memory for the selected model. Performance
and memory use depend on the model; this public extraction has no new hardware
benchmark. It does not install or replace any launchd services.

Start the API in a terminal:

```sh
node scripts/start-mac.mjs
```

It binds only `127.0.0.1:8788`. Setup stores admin/service tokens in
`data/mac-tts/auth.json` and a service client credential in
`data/credentials/mac-client.json`, both private. Check the API without printing
credentials:

```sh
python3 tools/mac-tts/client.py /health
python3 tools/mac-tts/client.py /v1/capabilities
```

Use an SSH tunnel for another host, and set that host's private client credential
`endpoint` to its loopback end of the tunnel. Copy only the service credential,
not the admin auth file. Keep the whole Mac state directory for stable references.

## Design and listen to a small voice pool

The committed examples describe synthetic voices, not clones of real people:

```sh
mkdir -p data/automation/auditions
cp tools/audiobooks/examples/local-cast-spec.json data/automation/auditions/cast-spec.json
cp tools/audiobooks/examples/local-tags.json data/automation/auditions/tags.json
python3 tools/mac-tts/design_book_cast.py --directory data/automation/auditions
```

This loads Qwen VoiceDesign and generates reference audio locally. First use
downloads model weights. Listen to every file under
`data/automation/auditions/references/ROLE/reference.wav`. Revise the descriptions
in a fresh audition directory if they are unsuitable; a saved reference pins the
voice identity. Add more compatible voices before following a story with a larger
cast, child characters, or other needs. A major new character needs a distinct
compatible reference. Missing gender evidence or a suitable voice stops the job
for review.

Choose a narrator matching the story's main character where established. The
example narrator is female; change the source specification for a different
story before auditioning. A shared pool has one default narrator, so use an
appropriate pool for that worker or explicitly seed each story's reviewed cast.

Import the auditioned pool:

```sh
node tools/audiobooks/dist/local-admin.js pool --state data/automation \
  --cast data/automation/auditions/cast.json \
  --references data/automation/auditions/references \
  --tags data/automation/auditions/tags.json
```

The importer copies reference WAVs, checks hashes, and writes `pool.json` plus
provenance. Keep the audition specification, tags, receipts, and original audio.
The source also includes `create_library_pool.py` for expanding a reviewed
narrator cast into a larger synthetic audition specification.

## Choose analysis and start the worker

For subscription analysis, install the official Codex CLI and sign in with your
own ChatGPT account. `codex login` and `codex login status` are documented in the
[official CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli).
See [authentication](https://learn.chatgpt.com/docs/auth) for supported sign-in
methods. Model access and allowances depend on your account.

Set `AUDIOBOOK_ANALYSIS_MODEL` in `.env` to a model available in that account.
The adapter requests structured output, uses a temporary isolated working
directory, and disables tools and repository instructions. Subscription failures
stop the job; it does not fall back to API billing. The installed CLI must support
the flags in `tools/audiobooks/src/codex-analysis.ts`.

In a separate terminal, from the repository root:

```sh
node scripts/worker.mjs
```

Now open Listener → **Tools → Source library**, paste a public Royal Road URL,
and choose:

- **Download text only** to save chapters without analysis or speech.
- **Next 5 unread chapters** to maintain a listening buffer.
- **Every available chapter** to generate the downloaded story in order.

Start with download-only, confirm the correct story and chapter order, then
change its mode. The worker analyzes, assigns saved voices, renders passages,
assembles audio, and publishes the `qwen` edition. Review a new cast and listen to
the first chapter before generating a long book. A story's voice history persists
across restarts. Cancel stops at a passage boundary; retry reuses checked WAVs.

### Optional API analysis

After the story has been downloaded, write a policy in `data/input/local-policy.json`:

```json
{
  "provider": "api",
  "model": "YOUR_SUPPORTED_MODEL",
  "budgetId": "my-book-pilot",
  "maxUsd": 1,
  "usdPerMillionInputTokens": 1,
  "usdPerMillionOutputTokens": 5,
  "maxOutputTokens": 24000,
  "maxAttempts": 2
}
```

The numbers above illustrate the fields; replace them with your approved ceiling
and current model prices before use. Put your own `OPENAI_API_KEY` in `.env` and
set `AUDIOBOOK_ANALYSIS_MODEL` to the same model. Stop the worker while changing
policy, then run:

```sh
node tools/audiobooks/dist/local-admin.js analysis-policy \
  --state data/fictions/rr-12345 --policy data/input/local-policy.json
```

Restart the worker. API calls reserve estimated cost before submission. Keep the
same budget ID across retries; unknown request outcomes retain their reservation.

## Manual local chapter rendering

For imported files, use the normal engine to configure and ingest chapter JSON,
then supply validated analysis with `analyze-import` or prepare it through the
paid analysis path. Prepare can spend OpenAI credits. Supply a `cast.json` whose
voice keys match the saved speaker IDs, plus `narrator` and `anonymous`. Each voice
needs its saved reference ID, checksum, exact transcript, and provenance.

The original Lantern examples use `mara` and `keeper`, matching the example local
cast specification. After creating that cast and importing the example analysis:

```sh
python3 tools/mac-tts/local_book.py prepare \
  --state data/fictions/lantern-pilot --directory data/automation/manual-lantern \
  --cast data/automation/auditions/cast.json --chapters lantern-1 --batch local-lantern
python3 tools/mac-tts/local_book.py render \
  --state data/fictions/lantern-pilot --directory data/automation/manual-lantern
python3 tools/mac-tts/local_book.py assemble \
  --state data/fictions/lantern-pilot --directory data/automation/manual-lantern \
  --batch local-lantern
FICTION_ID=lantern-pilot docker compose run --rm cli publish \
  --batch local-lantern --edition qwen --title 'The Lantern'
```

The README demo already provides the sample's validated analysis; it is usable for
this local speech experiment. Production casting still requires your listening
review. The renderer preserves request plans, resumable receipts, checked WAVs,
and source timelines. The queue worker provides the automated form of this flow.

## Advanced models and cleanup

The API retains adapters and schemas for Chatterbox, Kokoro, native Qwen, Fish,
MOSS, Higgs, VibeVoice, and FireRed. The basic installer prepares MLX and native
Qwen environments; other runtime environments need their corresponding lock and
adapter prerequisites. These advanced adapters are not part of the automatic Qwen
worker acceptance check. Check `/v1/capabilities` and the source before enabling
them. Their model licenses may differ.

The API runs one model worker at a time. Switching unloads the previous model.
References and saved voices persist; transient job IDs do not survive controller
restarts. `local_book.py` can archive a lost pending job and resume a local render.

Generated API audio can grow over time. After copying completed batch evidence
into persistent story state, run retention manually:

```sh
MAC_TTS_HOME="$PWD/data/mac-tts" python3 tools/mac-tts/maintenance.py
```

This removes generated API audio older than seven days and trims logs; it keeps
references, voices, prompts, and model weights. Schedule it yourself if desired.
