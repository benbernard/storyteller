# Supervised Inworld batch audiobooks

This optional workflow prepares source-grounded speaker assignments and acting
instructions through the signed-in Codex subscription, then generates Inworld
TTS-2 batches. It preserves saved voices and the reviewed narrator policy.
New speakers get a saved synthetic voice based on their source-grounded profile.

Generation runs in chapter order. An independent processing lane runs CPU ASR,
unprompted phonemes and structured AI review. Material omissions, wrong numbers,
repeats and inconclusive evidence receive bounded short retakes. Original audio,
request reservations and all review evidence remain available. Publication checks
text, audio checksums and byte-range requests using the deployed listener code
on an isolated loopback server. It does not change production authentication.

## Requirements

Use Node 22+, Python 3.11+, ffmpeg, rsync and SSH. The current ASR adapter uses
Apple MLX on CPU and the existing pinned Whisper environments. The phoneme
adapter needs the pinned wav2vec2 model and its Python environment. Other hosts
can supply compatible review adapters in a future change. Build the helper:

```sh
pnpm -C tools/audiobooks install --frozen-lockfile
pnpm -C tools/audiobooks build
node --test tools/inworld-batch/*.test.mjs
```

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

The supervisor prepares every selected chapter before rendering. It writes
`queue.json` once, then resumes that queue. Inputs cannot silently change after
preparation. The speech ceiling covers generation and retakes together; voice
design previews are separate provider charges. Confirm the current account price
and limits before setting the ceiling. Signed result URLs stay in private files.

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

## Recovery and AI follow-up

`supervisor-status.json` records stage, heartbeat, retry attempts and final status.
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
