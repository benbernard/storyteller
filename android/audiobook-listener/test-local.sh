#!/bin/bash
# Install and validate only the explicitly named development emulator.
set -euo pipefail
serial=${1:?Usage: test-local.sh emulator-PORT [application-id] [output-dir]}
app_id=${2:-io.github.benbernard.audiobooklistener}
output=${3:-.agent-scratch/listener-native}
case "$serial" in emulator-*) ;; *) echo 'Use an owned local emulator serial.' >&2; exit 2;; esac
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
: "${sdk:?Set ANDROID_HOME to the local Android SDK}"
adb="$sdk/platform-tools/adb"
root=$(cd "$(dirname "$0")" && pwd)
apk_root=${LISTENER_APK_DIR:-"$root/app/build/outputs/apk"}
mkdir -p "$output"
output=$(cd "$output" && pwd)
"$adb" -s "$serial" get-state
"$adb" -s "$serial" install -r "$apk_root/debug/app-debug.apk"
"$adb" -s "$serial" install -r "$apk_root/androidTest/debug/app-debug-androidTest.apk"
restore() {
  "$adb" -s "$serial" shell wm size reset >/dev/null || true
  "$adb" -s "$serial" shell wm density reset >/dev/null || true
  "$adb" -s "$serial" shell settings put system font_scale 1.0 >/dev/null || true
}
trap restore EXIT
run() {
  local name=$1 classes=$2
  "$adb" -s "$serial" shell am instrument -w -e class "$classes" "$app_id.test/androidx.test.runner.AndroidJUnitRunner" > "$output/$name.log"
  cat "$output/$name.log"
  "$adb" -s "$serial" exec-out screencap -p > "$output/$name-last.png"
  "$adb" -s "$serial" pull "/sdcard/Android/data/$app_id/files/screenshots" "$output/$name" >/dev/null
  if ! rg -q '^OK \(' "$output/$name.log"; then exit 1; fi
}
restore
run portrait 'com.crabanddog.listener.ListenerUiTest,com.crabanddog.listener.PlaybackTest,com.crabanddog.listener.AuthorNotePlaybackTest,com.crabanddog.listener.AuthorNoteOutputTest,com.crabanddog.listener.OfflineAudioTest'
"$adb" -s "$serial" shell wm density 160 >/dev/null
"$adb" -s "$serial" shell wm size 320x800 >/dev/null
"$adb" -s "$serial" shell settings put system font_scale 2.0 >/dev/null
run narrow-large 'com.crabanddog.listener.ListenerUiTest'
"$adb" -s "$serial" shell wm size 840x390 >/dev/null
run landscape-large 'com.crabanddog.listener.ListenerUiTest'
"$adb" -s "$serial" shell settings put system font_scale 1.0 >/dev/null
"$adb" -s "$serial" shell wm size 840x900 >/dev/null
run expanded 'com.crabanddog.listener.ListenerUiTest'
