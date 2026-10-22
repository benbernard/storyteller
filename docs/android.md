# Android Listener

Listener supports Android 13 and newer. It streams audio, saves verified audio
for offline listening, queues progress and issue reports, and reads along with
the text used for each recording.

The public application ID is `io.github.benbernard.audiobooklistener`. It can
coexist with the original app. The public build uses your server and signing
key; retain that key for future updates.

## Build for your server

Install Android Studio or a local SDK with platform 36/build-tools 35.0.0, JDK 17,
and Gradle 8.13. Set `ANDROID_HOME` and `JAVA_HOME`. Use your HTTPS origin with a
valid certificate, without a path or trailing slash:

```sh
cd android/audiobook-listener
./gradlew -PlistenerUrl=https://listener.your-domain.example \
  :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleDebugAndroidTest
```

The placeholder `https://listener.example.org` is not a working server. The URL
configures browser sign-in, API calls, streaming host checks, and offline routing.
HTTP is disabled. An emulator needs a trusted HTTPS endpoint reachable from its
network; its localhost is not your Mac.

The debug APK is `app/build/outputs/apk/debug/app-debug.apk`. Install it on an owned
test device with Android Studio or `adb install -r PATH_TO_APK`. Release builds
accept `AUDIOBOOK_LISTENER_KEYSTORE` and `AUDIOBOOK_LISTENER_STORE_PASSWORD`, using
alias `audiobook-listener`. Keep passwords out of shell arguments and Git. Increase
`AUDIOBOOK_LISTENER_VERSION_CODE` for each release. This package has no prebuilt
Android release binaries.

## Sign in and listen

Tap **Sign in**, finish the normal login in your browser, and return automatically
to Listener. There is no code to compare or extra device approval. The server
returns a short-lived code to the app's callback scheme; exchange requires the
verifier and state saved by the initiating app. Credentials and pending sign-in
proofs are encrypted with Android Keystore and excluded from backups. Legacy
pairing endpoints remain available to older installations.

Open a book and choose **Play book** or **Continue listening**. In **Chapters**, a
title opens text without moving audio. A chapter's Play icon starts it at the
beginning; the current chapter's Resume icon retains your position. Header Back
and Android Back return through visited screens, dismissing a sheet first.

Listening keeps the playing chapter and book in the header. Scroll to browse;
**Back to audio** restores the highlight and scroll without seeking. Tap a passage
to listen from it. Replay, Forward 30, Play/Pause, output selection, speed, issues,
and recent jumps stay with the bottom controls. Recent jumps lists the locations
left by deliberate jumps and returns, including their original edition and
recording. Periodic checkpoints and edition changes do not appear there.

**Listening settings** holds edition, text size, and **Include author notes**.
An edition change maps the current passage to its new recording timeline and
preserves playing or paused intent. If the passage or recording is unavailable,
the current audio stays in place. Text size has a live example sentence. Speed
presets cover every tenth from 0.8× through 2.5×, with custom entry from 0.1× to 4×.

Author notes are included by default. Turning them off omits tagged notes from
audio, text, and chapter times. Story content and chapter announcements remain.
The lock-screen player uses the shorter clock too. Older downloads may need a
text refresh to obtain note timings; unknown sections play in full. Automatic
note skips preserve Undo. An older Undo point inside a hidden note returns to
the preceding readable passage.

## Downloads, reports, and preparation

Downloads live inside each book. Choose an edition, keep it offline, and pause,
resume, or retry transfers there. Settings holds edition, Wi-Fi only, and the
2/8/32 GB phone storage limit. Changing the download edition does not change
playback. The book menu and long press also offer **Clear downloads**. Confirmation
clears that book's editions on this phone, pauses its downloads, and keeps its
listening place and other books' files, including shared audio.

**Mark issue** pauses and captures the playing recording even while browsing other
text. Close keeps a per-book draft; Discard draft removes it. Save queues one
stable report ID locally and retries sync. It never resumes playback. The book's
marked-issues list filters reports and uses an empty or filled checkmark for
Open and Resolved. The checkmark changes only after server confirmation; offline
and read-only accounts cannot change status.

Preparation stays inside an existing book. Published counts, worker phases,
cancellation requests, confirmed cancellations, and retry results reflect server
reports. Settings save explicitly. Pausing automatic checks leaves the active
job running. New story imports, book selection for generation, and narrator or
cast setup remain outside Listener.

**Account → Sign out** affects this phone. Finish or discard drafts and sync saved
work first. After successful device revocation, Listener removes local account
cache and downloads. Failed sync or revocation keeps the connection and data.
Other devices retain their sessions and synced work.

The website streams audio and has no Android download flow. Its browser manages
sign-in. Web audio-device selection depends on browser support; otherwise use
system sound settings. Android 14+ uses the system output selector, with system
media controls as the fallback on older or unsupported devices.

## Validate locally

Build the debug app and test APK, then run from the repository root:

```sh
android/audiobook-listener/test-local.sh emulator-PORT \
  io.github.benbernard.audiobooklistener .agent-scratch/listener-native
```

Use a dedicated, owned emulator: the script temporarily changes its display and
font size. It runs native UI and audio checks, then checks a 320 dp phone at 200%
text, landscape at 200%, and an 840 dp expanded layout. It restores emulator display
settings on exit. Results and screenshots stay in the specified output directory.
Set `LISTENER_APK_DIR` when an integration builds the app and test APK under a
different output directory. The live-server test is opt-in and is not part of
this synthetic matrix.

A build or emulator run does not prove physical Bluetooth routing or actual
fold/unfold transitions. Check those on the target hardware.
