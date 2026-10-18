# Android Storyteller

The app supports Android 13 and newer. It pairs with your server, streams audio,
saves checked audio for offline listening, keeps an event queue for progress and
issues, and reads along with the exact text used for a recording.

This public fork has its own application ID,
`io.github.benbernard.audiobooklistener`, so it can coexist with the original app.
It does not use the private homelab update service or signing keys. Build and sign
your own installation, and retain your keystore for future updates.

## Build for your server

Install Android Studio or a local SDK with platform 36/build-tools 35.0.0, JDK 17,
and Gradle 8.13. Set `ANDROID_HOME` and `JAVA_HOME` for your machine. The repository
includes the Gradle wrapper after its initial validation setup.

Use your own HTTPS origin with a valid certificate, no trailing slash or path:

```sh
cd android/audiobook-listener
./gradlew -PlistenerUrl=https://listener.your-domain.example \
  :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

The placeholder default `https://listener.example.org` is not a working server.
A build-time URL configures pairing, API calls, streaming host checks, and offline
routing together. HTTP is disabled. To test a local machine, provide a trusted
HTTPS endpoint reachable by the phone/emulator. Its localhost is not your Mac.

The debug APK is `app/build/outputs/apk/debug/app-debug.apk`. Install it on your
own test device with `adb install -r PATH_TO_APK` or Android Studio. Debug builds
are for development. Create a signed release using Android Studio for regular
use. The release Gradle configuration accepts `AUDIOBOOK_LISTENER_KEYSTORE` and
`AUDIOBOOK_LISTENER_STORE_PASSWORD`, with alias `audiobook-listener`. Keep passwords
out of shell arguments and Git. Use a rising `AUDIOBOOK_LISTENER_VERSION_CODE`
for each release. There are no prebuilt Android release binaries in this package.

## Pair and listen

1. Start Storyteller at the same HTTPS origin used in the build.
2. Tap **Connect account**. The app opens a browser pairing URL.
3. Sign in using your household Storyteller login, compare the code, and confirm.
4. Return to the app. Pairing expires after ten minutes. Restart if needed.

Device credentials are encrypted through Android Keystore and excluded from
backups. **Account options → Disconnect account** clears local state and attempts
to revoke the server grant. The household password is not embedded in the APK.

Open a title, choose an edition and chapter, then play. The queue advances through
available recordings. Progress and marked issues retry while the app/playback
service is active and sync again on opening or refresh. Downloaded verified audio
can play offline. Streaming needs a connection; changed recordings do not reuse
an old recording's timestamp as if the audio were identical.

In **Tools → Playback**, clear **Include author notes** to skip tagged opening,
closing and embedded notes. Notes stay included by default. Your choice also
applies to background and offline playback. Refresh a chapter online once to
obtain note timings for an older download; the audio does not need downloading
again. Sections without reliable note timings continue to play in full.

Use **Mark issue** for a voice, pronunciation, missing/repeated text, delivery, or
other problem. The report retains the recording and timestamp for later repair.
**Location history** and **Undo jump** help recover an earlier place.

The native tests cover compact/wide layouts and large text using synthetic audio.
A build or emulator run does not prove physical Bluetooth routing or fold/unfold
behavior. Check those on your own device.
