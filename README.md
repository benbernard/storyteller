# Audiobook System

Turn chapter text into a cast of persistent voices, generate chapter audio, and
listen on the web or Android with reading text and synced progress.

This is a standalone edition of a personal audiobook system. It includes story
downloads, paid ElevenLabs generation, local Qwen speech on Apple Silicon, a web
listener, and an Android app. You bring your own books, accounts, and hardware.

**License: [PolyForm Noncommercial 1.0.0](LICENSE).** Source is available for
permitted noncommercial use, modification, and redistribution. Commercial rights
are not granted by this license. See the full terms, including the provisions for
noncommercial organizations. Dependencies and model weights have separate terms. See [third-party notices](THIRD_PARTY.md).

## Features

- Downloads public Royal Road chapters into a resumable, versioned archive and
  exports EPUBs. Also imports EPUB, selectable-text PDF, TXT, or chapter JSON.
- Preserves the exact source text and tracks dialogue, narration, character
  identities, casting decisions, and recording timelines.
- Generates paid audio with ElevenLabs v3, Flash, or Multilingual v2, with explicit
  spending ceilings, cached requests, resumable batches, and selective repairs.
- Generates speech locally with Qwen on an Apple Silicon Mac. Automatic follows
  check for chapters and keep a listening buffer or generate the available book.
- Plays published editions in a browser or the Android app, with passage seeking,
  playback speed, progress history, issue reports, and Android offline downloads.

Local **speech** runs on your Mac. Speaker analysis still uses your configured
Codex subscription or an explicitly enabled OpenAI API workflow. It is not a
fully offline generation pipeline.

## Start here: run the listener demo

You need Git, Node.js 22.13 or newer, and Docker with Compose v2. On macOS or
Windows, start Docker Desktop first. The commands below use a POSIX shell; on
Windows, use WSL2 for these scripts. Local speech requires Apple Silicon macOS.

```sh
git clone https://github.com/benbernard/audiobook-system.git
cd audiobook-system
node scripts/setup.mjs
docker compose build listener
docker compose run --rm demo
docker compose up -d --wait listener
```

Open **<http://localhost:8080/listen/>**. Sign in as `listener` using the password
in `data/credentials/listener-password`. Read that file locally or open it in your
editor. Keep it private.

The demo publishes an original short scene with **silent synthetic audio**. Use
it to try the library, reader, seeking, and saved progress. It does not call an AI
provider, read provider keys, or demonstrate voice quality. Repeating the demo
reuses its recording. It lives in its own `lantern-pilot` story.

`setup.mjs` creates `.env`, private state directories, and a random password. It
preserves existing files and records your UID/GID for Docker volume ownership.
No login service, private registry, NAS, or original homelab is required.

## Choose a generation path

| Goal | Next guide | What you need |
| --- | --- | --- |
| Import chapters or your own book | [Importing](docs/importing.md) | Source text you may use |
| Generate audio with provider voices | [Paid generation](docs/paid-generation.md) | ElevenLabs and OpenAI API keys, explicit budgets |
| Generate speech on your Mac | [Local generation](docs/local-generation.md) | Apple Silicon Mac, model storage, analysis account |
| Listen on a phone | [Android](docs/android.md) | Android 13+, your server over HTTPS |
| Run a persistent server or restore a backup | [Operations](docs/operations.md) | Docker host and your own HTTPS endpoint |
| Develop or contribute | [Development](docs/development.md) | Pinned pnpm, FFmpeg, optional Android tools |

Start with one chapter. Review the speaker assignments and listen before scaling
up. Coverage checks catch missing source spans and damaged files; they cannot
prove that every line has the right speaker or that a generated voice sounds good.

## Where things live

```text
tools/audiobooks/          TypeScript engine, listener, worker, tests, examples
tools/royal-road/          Downloader and EPUB exporter
tools/mac-tts/             Mac speech API, adapters, model locks, local renderer
android/audiobook-listener/ Android client source
scripts/                   Standalone setup, demo, and worker launchers
data/                      Your private state, generated locally and ignored by Git
```

All user data stays under `data/` by default. Keep the entire directory when
backing up. The listener receives read-only fiction/archive mounts and its own
writable progress directory. Only generation processes receive provider keys.

## Scope and current limits

This is a technical self-hosting project. The listener demo is the shortest setup;
local voice casting and Android builds require additional steps. The public
edition has one household browser account, with separately paired devices.
It does not include the original BookOrbit deployment, private browser-account
scraper, NAS release pipeline, signing keys, or automatic Android updater.
BookOrbit import helpers remain in the engine, but that external integration is
optional and is not provisioned by Compose. Experimental Breeze production
scripts tied to the original host are excluded. Qwen is the automated speech path;
other retained Mac adapters are advanced, separately configured tools.

No chapter archives, generated books, personal listening history, voice samples,
model weights, or credentials are distributed here. The software license does not
grant rights to books, voices, or provider services. Use material and voice
references you have permission to process; review a provider's terms before
sharing generated recordings.

See [validation and limitations](docs/development.md#validation-record) for the
checks performed on this public edition.
