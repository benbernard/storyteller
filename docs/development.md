# Development

Run commands from the repository root. The TypeScript packages keep their
own frozen pnpm lockfiles. They do not depend on the original monorepo.

## Engine, downloader, and speech API

Use Node 22.13+ and pnpm 10.33.0. FFmpeg/FFprobe must be on PATH for audio tests.
The downloader's Sharp dependency needs its normal platform-specific package.

```sh
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm -C tools/audiobooks install --frozen-lockfile
pnpm -C tools/royal-road install --frozen-lockfile
pnpm -C tools/mac-tts install --frozen-lockfile
pnpm run build
pnpm test
pnpm -C tools/audiobooks exec playwright install chromium
pnpm -C tools/audiobooks test:browser
```

Tests use synthetic source text, fake provider responses, and decodable test
audio. They do not need credentials or make paid requests. Browser tests cover
320, 768, 840, 1024, and 1440 pixel viewports, including dark mode and reduced
motion. The standalone identity test covers login, forged identity headers,
Origin checks, device pairing, and token revocation.

The standard-library Python tests run without downloading speech models:

```sh
cd tools/mac-tts
python3 -m unittest test_local_book test_review_local_book test_retake_local_book test_audition_cache
cd acting-auditions
python3 -m unittest test_generate test_sequence_gate test_speech_parts test_assembly_quality test_design_breeze
```

`test_fish_prompt.py` needs the Fish/MLX runtime, so it is not part
of the portable offline suite. All first-party Python has parameter/return
annotations and is linted with pinned Ruff, including annotation rules:

```sh
python3 -m pip install -r tools/python-quality/requirements.txt
python3 -m ruff check tools/mac-tts
```

## Docker smoke check

The smoke script starts a fresh listener on a free local port, verifies login and
private-route rejection, reads the demo's text, and checks HTTP byte ranges. It
uses local generated demo state and never calls providers.

```sh
node scripts/setup.mjs
docker compose build listener
docker compose run --rm demo
node scripts/smoke.mjs
```

The script cleans up only its own test container. The README's persistent
listener is independent. Keep `data/` private even when it only contains a demo.

## Android

See [Android setup](android.md). Unit tests and lint run locally and in GitHub
Actions. Build the test APK, then run on an Android 13+ emulator/device:

```sh
cd android/audiobook-listener
./gradlew :app:assembleDebugAndroidTest
./gradlew :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.crabanddog.listener.ListenerUiTest
```

LiveFlowTest is an opt-in integration test for a separately prepared server. Do
not run it against another person's account. The UI and playback fixtures use
synthetic books and audio. Debug builds are development artifacts; release signing
and publication are the fork owner's responsibility.

## Validation record

The initial public edition was checked locally on Apple Silicon macOS with Node
24.21.0, pnpm 10.33.0, FFmpeg, Docker 29.4.0, JDK 17, Android SDK 36, and Gradle
8.13. The Docker runtime uses Node 22. These checks cover the extracted standalone
code, not the state of the original deployment.

- TypeScript builds and offline tests for the engine, downloader, and Mac API.
- Standard-library Python planning, review, cache, and repair tests.
- Browser interactions across five viewport widths.
- Docker image build, repeatable silent demo, login and API smoke checks.
- Android unit tests, debug lint, debug APK, and instrumentation APK builds.
- Native UI fixtures at 390dp/130% text and 840dp, plus 320dp/200% text in dark mode.

Paid synthesis, a fresh model download, a new Mac inference run, successful
subscription analysis with another account, physical phone/Bluetooth behavior,
and a Linux/Windows friend's installation are not established by these tests.
The repository includes CI so future source changes repeat its portable checks.
See the GitHub Actions runs for verification of the published revision.

On the validation Mac, `avdmanager` could not load missing `devices.xml` files in
the existing SDK. A separate task-owned AVD using the installed Android 36 ARM64
image booted and ran the fixtures. Existing AVDs were left unchanged. The large-text
fixture scrolls to the edition picker before checking its controls.

## Breeze and Inworld validation

The Breeze tests cover exact source coverage, voice identity and stage changes,
immutable resumed inputs, lease contention, transcript/phoneme decision binding,
bounded retakes, and publication checks. The optional numerical regression test
uses small real MLX layers without downloading the Breeze model:

```sh
data/mac-tts/venv/bin/python -m unittest discover \
  -s tools/mac-tts/acting-auditions -p test_breeze_fast.py
```

It compares cached and stock decoding, checks deterministic replay and frame
isolation, and rejects an intentionally broken cached decoder. It is a Mac check;
Linux CI runs the portable tests. A numerical check does not establish full-model
speech quality.

Inworld tests inject unary JSON responses containing synthetic WAV audio. They
check unchanged Portal credentials, canonical request fields, UTF-16 boundaries,
base64/size/usage validation, hidden error bodies, pre-request budgets, resume and
cache reuse, provider selection, and edition model checks. They make no paid
calls. A fresh model download, full Breeze voice/chapter generation, live Inworld
access, and another user's subscription remain installation checks for the
operator.

For the Breeze/Inworld addition, local checks also exercised the Breeze import and
job-initialization commands with synthetic references. A synthetic Breeze chapter
passed the actual Python plan/assembly path, TypeScript publication, and live
loopback Listener checks for reading text, audio checksums, and HTTP ranges. The
small-layer MLX numerical test passed on Apple Silicon with MLX 0.32.3 and
mlx-audio 0.5.7. These checks generated no speech and made no provider requests.
