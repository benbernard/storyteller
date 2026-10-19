## Silent author-note skips

Excluded author notes are silenced in decoded audio before they reach the output
buffer. Playback still skips their ranges, including during chapter transitions,
seeks and offline listening. Chapter announcements and story content retain their
original positions. Changing the checkbox flushes already buffered audio.

# Restore the happy book icon

Restored the original smiling book with turquoise headphones for the Android
launcher, in-app branding and web listener. Existing library and playback data
are unchanged.

# Storyteller for Android 0.3.1

The app is now called Storyteller. This update adds the Bookwave launcher icon and
uses the same name and mark in the library and connection screens. The media
notification also uses the renamed application label.

The application ID and signing configuration remain the same, so an update signed
with your existing key keeps pairing, progress, and offline downloads. Use a fresh,
higher `AUDIOBOOK_LISTENER_VERSION_CODE` for your release.
