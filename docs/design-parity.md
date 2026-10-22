# Listener design verification

The Listener redesign follows the approved page and flow review. Tests render the
actual Android and web components using the same fictional books and chapter text
as the approved mock. They cover the library, Book, chapters, reader, playback and
font settings, speed, reports, recent jumps, preparation, and account screens.
Android also covers per-book downloads and clearing them.

A passing interaction test does not establish visual parity. Review captures
beside the approved reference and record each difference before accepting a
release. Inspect normal and large text, both appearances, narrow and expanded
windows, keyboard behavior, loading, empty, offline, failed-save, permission, and
cancellation states. System audio routing and browser-managed sign-in use their
platform interfaces.

## Browser checks and captures

Install the pinned workspace dependencies, then install the matching Chromium:

```sh
pnpm install --frozen-lockfile
pnpm -C tools/audiobooks exec playwright install chromium
pnpm -C tools/audiobooks test:browser
```

`test:browser` runs playback/persistence checks and the design capture matrix.
The capture server binds only to loopback and uses fictional data. It never
contacts a production API. To save images, set `SCREENSHOTS` to a disposable
absolute directory. `DESIGN_COVERS` may point to the four approved cover PNGs
(`lighthouse.png`, `tides.png`, `orchard.png`, `midnight.png`). Without them, the
same layout uses neutral cover placeholders. Artwork must be obtained from its
approved, checksum-verified asset source.

```sh
SCREENSHOTS=/absolute/scratch/web \
  node tools/audiobooks/test-design-parity.mjs
```

The matrix checks 320, 390, 840, and 1440 px widths, 200% text, a short landscape
window, dark appearance, and reduced motion. It also checks recovery after failed
refreshes and saves, read-only reports, unavailable recordings, and preparation
states. Images and their checksums are written beside `web-evidence.json`.

## Android checks and captures

Use a local Android 36 emulator. Build and install the debug app and test APK with
the repository's Android SDK and JDK 17 setup. `DesignParityTest` renders actual
components; the playback, download, and cover-cache tests check their real storage
and player behavior separately. `LiveFlowTest` is opt-in and requires its dedicated
QA-account harness.

`capture-native-design.mjs` requires an explicit emulator serial and a dedicated
AVD name. It refuses a physical device or a different AVD. It temporarily changes
only that emulator's window, density, font scale, and appearance, then restores
those settings. Install both APKs before running it:

```sh
ANDROID_HOME=/absolute/android-sdk ANDROID_SERIAL=emulator-5582 \
  DESIGN_AVD=listener-parity SCREENSHOTS=/absolute/scratch/native \
  node tools/audiobooks/capture-native-design.mjs
```

The default profiles are a 390 dp phone, 320 dp with 200% text, landscape with
200% text, and an expanded dark window. `DESIGN_PROFILE` selects one profile for
an isolated retry. Private package integrations can set `DESIGN_PACKAGE`.
The optional `design-covers.png` atlas belongs in the test app's external files
directory. The test assets, activity, and artwork injection are absent from the
release app's navigation and data.

## Fixture maintenance

`tools/audiobooks/test-fixtures/listener-design.json` contains the fictional review
content and its API projection. `scripts/generate-design-fixture.mjs` rebuilds the
projection after an intentional fixture change. It calculates real checksums for
the synthetic download files, keeps preparation separate from publication, and
retains per-book positions and issue locations. Do not replace the approved
reference or change production behavior merely to make a fixture pass.

## Compare with the approved reference

The portable review tools live in this repository. Serve the original approved
HTML files on loopback without changing their contents, then capture references
and generate the comparison gallery:

```sh
node scripts/capture-design-reference.mjs --source /absolute/storyteller \
  --output /absolute/scratch/parity/reference --base http://127.0.0.1:8771
node scripts/design-review-report.mjs /absolute/scratch/parity CHECKED_SOURCE_SHA
```

The reference capture tool checks both approved HTML hashes. The gallery compares
reference, Android and web captures at phone, large text and expanded dark sizes.
It includes playing, paused and Undo states. Android images are normalized to
logical dp. Platform fonts, Android's nonlinear text scaling, accessible touch
targets, system bars and system device routing are recorded adaptations.
