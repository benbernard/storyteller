# Reading continuation integration

The listener can accept chapter handoffs from a trusted reading integration.
It keeps the selected audio edition and preserves the exact audio timestamp when
the incoming marker identifies the current chapter. Missing audio leaves the
playable bookmark unchanged. Reading handoffs do not mark audio completed or
advance the audio-based character boundary.

Authenticated management clients use these API suffixes:

- `GET /sync/status?story=ID` returns the revision, position and recent changes.
- `POST /sync/preview` accepts `story`, `chapterId`, `source` (`bookorbit` or
  `royal-road`), numeric `sourceRevision`, and `expectedRevision`.
- `POST /sync/apply` accepts the preview's `id`.
- `POST /sync/undo` accepts a successful change's `id`.

These routes use the existing `/listen` browser and `/api/listener` device
prefixes and require library-management permission. Deployments can additionally
set `ListenerIntegrations.continuationControl` to a filesystem `socket` and a
pinned `owner`. That socket accepts only continuation operations for that account.
Its parent directory must already be private and writable by the listener user.
The socket is created with mode 0600. Do not expose it as a public HTTP endpoint.

Previews expire after ten minutes and bind the exact current state and source
acknowledgements. Apply and ordinary progress writes share the listener's mutation
queue. Repeated applies use the same event identity. Undo requires that playback
has not moved since the imported change. Check the action and saved flag for an
unavailable or already-acknowledged source revision.

After a handoff, progress events must include the `continuationRevision` captured
when that playback session started. Older events remain in listening history but
cannot replace the newer continuation. Web and Android clients retain that
revision through active playback and adopt the current one for a new session.
A handoff does not seek an active player or start playback automatically.

The library's state includes `continuations`, `syncSources` and `syncChanges`.
Revisions are comparable within a story only. Keep native source bookmarks and
cross-format continuation separate, and acknowledge each destination independently.
The first integration uses stable chapter IDs. Precise EPUB/text/audio mappings
and reverse reading handoffs are separate work.
