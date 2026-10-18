# Supervised Inworld batch audiobooks

This optional workflow prepares source-grounded speaker assignments and acting
instructions through the signed-in Codex subscription, then generates Inworld
TTS-2 batches. It preserves saved voices and the reviewed narrator policy.
New speakers get a saved synthetic voice based on their source-grounded profile.

Generation runs in chapter order. An independent processing lane runs ASR,
unprompted phonemes and structured AI review. Material omissions, wrong numbers,
repeats and inconclusive evidence receive bounded short retakes. Original audio,
request reservations and all review evidence remain available. Publication checks
text, audio checksums and byte-range requests using the deployed listener code
on an isolated loopback server. It does not change production authentication.

The paid worker can keep three batch operations in flight within a chapter.
It reserves and submits each group in sequence, then reconciles accepted operations
in sequence while Inworld generates them concurrently. Pending reservations count
against the same speech ceiling. A pause stops new submissions and drains known
accepted operations. Any uncertain submission stops further paid work and retains
its reservation. This keeps one ledger writer and one worker lock.

The default window is below Inworld's documented five concurrent batch jobs for
On-Demand accounts. The 9,500-character packing cap remains below that plan's
10,000-character per-job limit. See [job concurrency limits](https://docs.inworld.ai/resources/job-concurrency-limits).

## Requirements

Use Node 22+, Python 3.11+, ffmpeg, rsync and SSH. The current ASR adapter uses
Apple MLX and the existing pinned Whisper environments, with CPU as its default. The phoneme
adapter needs the pinned wav2vec2 model and its Python environment. Other hosts
can supply compatible review adapters in a future change. Build the helper:

```sh
pnpm -C tools/audiobooks install --frozen-lockfile
pnpm -C tools/audiobooks build
node --test tools/inworld-batch/*.test.mjs
python -m unittest discover -s tools/inworld-batch -p '*_test.py'
```

## Faster independent review

ASR checks run in two passes: the small model checks every pending passage,
then the stronger model checks only passages that need it. This avoids repeatedly
reloading model weights. Intermediate results are bound to the audio checksum,
expected text and pinned model paths, so an interruption can resume without
repeating completed checks. Models, decoding precision and quality thresholds
stay the same.

The ahead reviewer can check generated chapters while the main worker processes
another chapter. It never calls Inworld or edits the paid ledger. It snapshots
inactive chapters into private job scratch and imports only missing reports whose
input, audio and receipt hashes still match. It skips active or published chapters
and never replaces an existing review. The main worker retains responsibility for
phoneme checks, AI adjudication, retakes and publication.

```sh
node tools/inworld-batch/review-ahead.mjs /private/job/queue.json
```

For Apple GPU review, use the existing local speech service's credential and lease:

```sh
node tools/inworld-batch/review-gpu.mjs /private/mac-tts/auth.json -- \
  node tools/inworld-batch/review-ahead.mjs /private/job/queue.json
```

The wrapper acquires, renews and releases its own GPU lease. It refuses active or
queued local speech work, never stops another worker, and stops its review process
if renewal fails. Run the CPU command if the lease is unavailable. Only this wrapper
should set `INWORLD_REVIEW_DEVICE=gpu` and `INWORLD_REVIEW_GPU_LEASE=1`. Status is
saved separately in `review-ahead-status.json`; the main worker's status and locks
are preserved. Re-running skips completed evidence and discovers newly generated
chapters.

Credentials stay on the remote synthesis host. `credentialFile` names its private
Inworld env file. The fixed-host gateway sends it only to `api.inworld.ai`.
The Codex executable is selected with `AUDIOBOOK_CODEX_BIN`. Analysis and review
force ChatGPT authentication, disable tools and never fall back to paid API use.

## Configure and run

Keep every job configuration and state directory private. Copy only the selected
fiction's source index, immutable sources, cast and author-note archive records
into the local job's input directories. No audio provider is called during planning.

The planner JSON contains `state`, `archive`, `directory`, `model`, and the
previous chapter's cumulative `context`. `archive` is the directory containing
that fiction's `manifest.json` and `records/`. It must match the imported text.

The supervisor JSON contains:

- `root`, `fiction`, `edition`, and ordered `chapterIds`.
- `planner` (absolute path to `tools/audiobooks/dist/inworld-plan.js`),
  `plannerConfig`, and `plans` (the planner's `directory`).
- Optional `priorQueue`, pointing to an earlier completed batch queue. Its source
  evidence restores previously voiced speakers missing from the source roster,
  without exposing later-chapter identities. A saved voice without identity
  evidence stops preparation rather than receiving a new identity.
- `originalVoices` copied from the previously accepted Inworld cast, and
  `narratorPolicy` recording the source-supported gender and casting decision.
- `host`, `credentialFile`, `archive` (remote checkpoint directory), and
  `remoteFictions`. The remote worker and listener container names default to
  `audiobook-worker` and `audiobook-listener`; override with `workerContainer`
  and `listenerContainer`. Publication ownership uses `ownerUid` and `ownerGid`.
- `python` for the MLX ASR environment and `phonemePython` for independent review.
- `automaticRepair: true`, `reviewModel`, `maxRetakes`, `pollSeconds`,
  `maxBatchCharacters` (9500 for a 10000-character account cap), a positive
  `ceilingUSD`, and the verified `usdPerMillion` speech price.
- Optional `acronyms` and literal `pronunciations`, retained in the saved plans.
  These normalize spoken notation. They preserve the immutable reading text.
- Optional `batchPrefix`, `maxRecoveryAttempts` (8), `retrySeconds` (30), and
  `maxRetrySeconds` (1800).

```sh
node tools/inworld-batch/supervisor.mjs /private/job/config.json
```

The supervisor sends ready chapters to one Inworld worker while preparation
continues. It appends chapters in source order to `queue.json`; queued inputs,
selected chapters and billing settings cannot change. The speech ceiling covers
generation and retakes together; voice
design previews are separate provider charges. Confirm the current account price
and limits before setting the ceiling. Signed result URLs stay in private files.

Long chapter attribution uses bounded subscription requests with the full chapter
as context. Validated windows are checkpointed and reused after interruptions.
The merged result must cover the exact source and preserve speaker identities;
speech tags are checked across window boundaries before preparation continues.

Character discovery runs in source order so each chapter receives the preceding
summary and established identities. It records new characters and supported
aliases in `state/inworld-character-registry/events/`. Direction workers use
immutable attribution snapshots and share those established IDs. Two direction
workers run by default (`directionConcurrency`, from one to four), each making
bounded subscription requests. The paid worker serializes generation and retakes
against the same reservations and spending ledger.

Install a clean committed runtime on macOS with:

```sh
node tools/inworld-batch/install-macos.mjs /private/job/config.json \
  org.example.storyteller-inworld /absolute/path/to/codex
```

The installer archives the exact Git commit, installs frozen dependencies, builds
the planner, and saves a source receipt. It backs up the configuration and any
previous LaunchAgent. It refuses an active supervisor or renderer. The job uses
`caffeinate`, `RunAtLoad`, an unsuccessful-exit restart policy and a periodic start
interval so a reboot or network outage does not require an open chat. Avoid a
second supervisor for the same job. Pin and record its source commit.

Before upgrading an active job, create `pause.requested` and wait for `status.json`
to say `paused` and for `worker.lock` to disappear. The worker reconciles accepted
provider operations and finishes the active review before pausing. Queued reviews
wait for resume. Then stop that job's
LaunchAgent, install the committed runtime, create `resume.requested`, and start
the LaunchAgent. Never kill an in-flight paid request to speed up an upgrade.

With an active worker, `--stage-only` installs the committed runtime without
changing the active configuration or LaunchAgent. It records `pending-runtime.json`
for application at a safe idle point. Older runtimes may drain their whole review
backlog before pausing; staging lets a validated compatibility repair proceed
without interrupting paid work.

For an unqueued chapter blocked by an older runtime's concealed-speaker role
mapping, the staged `tools/audiobooks/dist/inworld-checkpoint-repair.js` accepts
`JOB_CONFIG CHAPTER_ID EXPECTED_SOURCE EXPECTED_ATTRIBUTION`. The final argument
is the `fingerprint()` of the parsed attribution checkpoint. Run it only while
that chapter's preparation is idle. It checks source and checkpoint hashes,
refuses queued inputs or existing directions, preserves the original evidence,
and maps concealed dialogue to the existing anonymous voice. Source text, span
identities, hidden identity evidence and paid reservations remain intact.

## Recovery and AI follow-up

`supervisor-status.json` records stage, heartbeat, retry attempts and final status.
Its `lanes` object retains each preparation and rendering stage's health, error
and next retry time. Check these records alongside the overall status: another
worker's progress must not hide a failed stage.
`status.json` records generation, and `processing-status.json` records review and
publication. `supervisor.log` and chapter files contain private diagnostic evidence.
Transport, subscription and processing failures retry with exponential backoff.
Already generated clips, model responses and immutable publications are reused.

An unknown paid submission never gets blindly resubmitted. Credit, access and
budget failures retain their evidence and enter `needs-attention`. Review that
state before creating `resume.requested` and restarting the supervisor. A monitor
can safely retry a repaired transport or a corrected, committed runtime. It must
reconcile operation IDs before touching uncertain submissions, retain the spending
ledger and avoid replacing saved voices or source text.

An AI monitoring task should periodically inspect the supervisor, investigate
held stages, fix reusable software bugs in Storyteller, validate and install a
new committed runtime while idle, then resume the same job. It should stop itself
only after every selected chapter has a verified publication receipt. Exhausted
retakes remain in `review-backlog`. Do not silently accept them to finish a run.

The original processing-only and audio-bound owner-review tools remain available
for an explicitly reviewed exception. They cannot waive changed recordings.
