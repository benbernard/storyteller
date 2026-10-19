# Synthetic audio fixture

`note-tone.mp3` contains a four-second 440 Hz sine wave, with no book content.
It tests decoded PCM after MP3 encoder trimming and across chapter transitions.

Generate it locally with FFmpeg:

```sh
ffmpeg -v error -f lavfi -i sine=frequency=440:sample_rate=44100:duration=4 \
  -c:a libmp3lame -b:a 128k note-tone.mp3
```
