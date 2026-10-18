# Breeze on an Apple Silicon Mac

Breeze is the recommended local speech path in this package. It is the owner's
preferred renderer after comparing it with Qwen. Treat that as a listening
preference: audition your own cast and chapter before generating a book.
[Qwen](local-generation.md) remains available, including its automatic follows.
Breeze uses explicit chapter jobs. It does not run through the Qwen follow worker.

Breeze generates speech on your Mac. Speaker attribution, voice selection,
acting directions, and review decisions use your signed-in Codex subscription.
Chapter text and review transcripts are sent to that account. There is no paid
API fallback if subscription analysis fails. Inworld is a separate
[API generation path](inworld.md).

## Install the runtime

Use Apple Silicon macOS, Git, Node 22.13+, pnpm 10.33.0, FFmpeg, uv, and a Codex
CLI version supporting `exec --output-schema`, `--ignore-user-config`, and
`--ignore-rules`. Install and sign in to Codex using the
[official CLI instructions](https://developers.openai.com/codex/cli/).
Choose an analysis model available to your account in `.env`:

```dotenv
AUDIOBOOK_ANALYSIS_MODEL=your-account-model
```

Run the README listener demo first, then install the local packages:

```sh
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm -C tools/audiobooks install --frozen-lockfile
pnpm -C tools/royal-road install --frozen-lockfile
pnpm -C tools/mac-tts install --frozen-lockfile
pnpm run build
node scripts/setup-breeze.mjs
node scripts/start-mac.mjs
```

Leave the last command running in its own terminal. It starts the loopback-only
speech service on port 8788. Breeze uses its exclusive GPU lease; it does not load
Qwen. The installer creates private client credentials and three Python 3.12
environments under `data/mac-tts/`: generation, Whisper review, and CPU phoneme
review. The phoneme environment uses the same pinned package lock as generation.
It downloads the exact model revisions used by the renderer and reviewers.

Allow tens of gigabytes for models, Python environments, and caches, plus space
for WAV passages and backups. This renderer caps MLX memory at 30 GiB; that is a
limit, not a claim that a smaller Mac can run the whole job. The package has not
established a minimum-memory specification. Begin with one chapter and monitor
memory. Model weights are downloaded as BF16, then the backbone and depth decoder
are quantized to eight bits in memory. The codec and text encoder retain their
original precision. The cached decoder checks its numerical agreement before use.

To put these files on another drive, set `MAC_TTS_HOME` to an absolute path in
`.env` before setup. Keep that setting for subsequent commands. Use
`node scripts/setup-breeze.mjs --skip-download` only when the pinned models are
already cached there. A missing revision stops generation; it does not fetch a
newer model silently. Do not run this installer over an unrelated speech service's
data directory.

Review the [Breeze model terms](https://huggingface.co/BreezeBlue/Breeze-TTS-2)
before downloading or sharing output. Its model terms are separate from this
repository's PolyForm license. The
[MLX port](https://huggingface.co/mlx-community/Breeze-TTS-2-mlx) is pinned in
`tools/mac-tts/acting-auditions/models.json`. Review models are pinned in
`download_models.py`.

## Design and listen to a cast

The included voice brief uses original sample text and synthetic voice design.
It does not require voice recordings or a Qwen model. Copy it before editing:

```sh
mkdir -p data/voices/my-cast
cp tools/audiobooks/examples/breeze-voices.json data/voices/my-cast/voices.json
cp tools/audiobooks/examples/breeze-tags.json data/voices/my-cast/tags.json
node scripts/breeze.mjs design --directory data/voices/my-cast
```

Edit `voices.json` before running design. Each voice has a unique role, a short
reference transcript, a prose voice instruction, and an explicit seed. Match the
narrator to the main character's gender when the story establishes it. Add voices
for children or other source-supported portrayals as needed. `anonymous` must
sound different from the narrator. Seeds help reproduce a run within the pinned
runtime. They do not guarantee identical audio on every machine.

Listen to every `references/ROLE/reference.wav`. Confirm that it speaks the exact
reference transcript without omissions, extra words, or effects. These WAVs become
the identity anchors for the book. `cast.json` records their transcripts,
checksums, IDs, and design provenance. The script does not mark a voice as approved
by a listener. If a design is unsuitable, create a new cast directory with an
edited brief or seed. Repeating an unchanged completed design verifies and reuses
its saved recordings.

Edit `tags.json` to describe the voices you accepted. The supplied adult female,
adult male, and neutral entries are examples. Listening must support those tags.
`identities: ["*"]` lets the casting stage use that voice for compatible new
speakers. A specific identity such as `["mara"]` reserves it for that source
character ID. Use source evidence for gender and age. Names alone are not evidence.
The neutral voice covers speakers whose gender or age is unstated. The author-note
voice defaults to the distinct anonymous reference. You may supply its own role.

## Import chapters and initialize one job

Download or convert your source using [Importing](importing.md). The Breeze import
command accepts the same chapter JSON and creates an import configuration with
zero paid spending ceilings if that fiction has no configuration yet:

```sh
node scripts/breeze.mjs import --fiction my-book --file data/input/chapters.json
```

The records must contain `fictionId: "my-book"` and stable chapter IDs. For a
Royal Road archive, use its ID, such as `rr-12345`, and the archive's
`data/archive/rr-12345/chapters.json`. Import does not call a provider. Avoid mixing
paid and local production workers on the same fiction while a job is running.

Use a clean, committed source checkout for production. Initialize selected chapter
IDs in reading order; replace these example values with the imported IDs:

```sh
node scripts/breeze.mjs init \
  --fiction my-book --chapters chapter-1 \
  --cast data/voices/my-cast/cast.json --tags data/voices/my-cast/tags.json \
  --title 'My book' --author 'Author' --job first-chapter \
  --reason 'Generate and review this selected chapter using the cast I have auditioned.'
```

This creates `data/breeze/first-chapter/book.json`, copies the reference WAVs,
and records the casting authorization in the fiction state. Review the generated
catalog, chapter selection, and presentation before running. Presentation includes
chapter titles and available archive author notes. An optional `--presentation`
file can replace it with a chapter-ID map containing `title`, `before`, and `after`.

The job pins the repository commit, source text, reference catalog, model, and
preparation inputs. It rejects changed tooling or incompatible resumed inputs.
For a changed source commit or cast, initialize a new job. A previously established
speaker keeps its saved voice; an evidenced transformation can introduce an exact
within-chapter stage change. To intentionally recast, first back up the fiction
state and review `breeze-cast.json`, `breeze-cast-head.json`, and
`breeze-voice-identities.json`, and `casting-review.json`. A new job at an earlier completed chapter needs a reviewed
cast reset or separate fiction state. There is no automatic recasting command.

## Generate, review, and publish

Keep the local speech service and the Compose listener running. Listener must use
the same `data/fictions/` directory and credentials as this checkout. The job uses
`LISTENER_PUBLIC_URL` and `LISTENER_USERNAME` from `.env`, and reads the private
password file created by `scripts/setup.mjs`.

```sh
node scripts/breeze.mjs run --config data/breeze/first-chapter/book.json
```

For each selected chapter, the worker prepares exact source spans and acting
directions, generates Breeze passages, and runs independent Whisper transcription.
Flagged passages receive contextual Whisper and CPU phoneme evidence before a
subscription model classifies them. A bad or uncertain passage can receive at
most three retakes with new seeds. Originals remain in the trial directory.
These checks assist review and cannot establish voice quality or perfect speech.
Listen to the chapter yourself.

Passing chapters publish as the `breeze` edition. Minor issues publish by default
with provisional quality evidence. Set `queue.publishMinor` to `false` in
`book.json` before running to hold those chapters too. Major or uncertain issues
remain unpublished drafts, with `guidance-request.json` describing what needs
attention. Later selected chapters may still generate; the initialization reason
records that authorization. The worker checks the published audio checksum,
reading text, and HTTP byte ranges against Listener. An existing book's default
edition is preserved. Choose Breeze in the edition picker.

Inspect `status.json`, per-chapter logs, `trials/CHAPTER/review/`,
`review-decisions.json`, and publication receipts under the job directory. Keep
these files with the fiction state when backing up. A model decision is automated
evidence, not a claim that a person listened.

To pause, send Ctrl-C once and allow the worker to release its lease. It records
`pause.requested`. Chapter renderers may also record `cancel.requested`. After the
worker has exited and you have reviewed the reason, remove those pause/cancel
markers in that job and repeat the same run command. Completed passages are
checksum-checked and reused. Do not delete receipts or change source/cast files to
force a retry. For a blocked draft, inspect its saved evidence before deciding on
a corrected cast, delivery direction, or a new job. The paid engine's `correct`
command does not automatically rewrite a Breeze trial.

The portable tests exercise planning, leases, cast continuity, quality gates,
retakes, and publication checks. See [Development](development.md) for the precise
validation limits, including the distinction between numerical decoder tests and
a fresh full-model synthesis run.
