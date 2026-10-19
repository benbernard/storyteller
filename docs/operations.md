# Run and maintain the service

## Configuration

`node scripts/setup.mjs` creates private state and a random login password. Compose
loads `.env`; you can change these values there:

| Setting | Default | Purpose |
| --- | --- | --- |
| `LISTENER_PUBLIC_URL` | `http://localhost:8080` | Exact browser origin, including port |
| `LISTENER_BIND` | `127.0.0.1` | Docker host interface |
| `LISTENER_PORT` | `8080` | Docker host port |
| `LISTENER_USERNAME` | `listener` | Stable household account identity |
| `LOCAL_UID`, `LOCAL_GID` | Setup user's IDs | Filesystem ownership inside containers |
| `FICTION_ID` | `lantern-pilot` | Fiction directory for CLI operations |
| `AUDIOBOOK_ANALYSIS_MODEL` | Placeholder | Explicit local-worker analysis model |
| `OPENAI_API_KEY`, `ELEVENLABS_API_KEY` | Empty | Paid CLI credentials |

Restart Storyteller after changing its configuration. Its password comes from
`data/credentials/listener-password`, not an environment variable. Rotate it by
replacing that file with a new random password of at least 24 characters and
recreating the container. Keep the username stable: changing it creates a different
listening account. Password rotation does not revoke existing paired devices.
Disconnect each device separately if needed.

## HTTPS and phone access

The default port is loopback-only for local setup. For a phone or remote browser,
put your own HTTPS reverse proxy in front of it and set `LISTENER_PUBLIC_URL` to
that exact origin, with no path or trailing slash. Preserve the public `Host`,
`Authorization`, `Origin`, and Range request headers. Route both `/listen/` and
`/api/listener/` to the same server, and do not cache private responses. The root
path redirects to Storyteller.

For a reverse proxy running on the host, forward to `http://127.0.0.1:8080`.
For example, a host Caddy configuration can contain:

```caddyfile
listener.your-domain.example {
    reverse_proxy 127.0.0.1:8080
}
```

Use a real domain and a valid certificate your phone trusts. Do not expose the
plain HTTP port to the internet: browser login uses HTTP Basic authentication and
needs HTTPS outside loopback. The Android API uses revocable device tokens and
must also travel over HTTPS. Set the Android build's URL to this same origin.

The listener supports an optional Authentik mode in source. It requires a pinned
UID, email mapping, and exact trusted proxy peers. Compose intentionally uses
standalone Basic auth so an identity provider is not required. If adapting proxy
identity mode, prevent direct access to the application and strip untrusted
identity headers before the trusted proxy supplies them.

## Start, stop, and inspect

```sh
docker compose up -d --wait listener
docker compose ps
docker compose logs --tail 100 listener
docker compose down
```

`/healthz` reports process readiness without revealing the library. It does not
prove that speech generation, provider access, or the Mac is available. A running
listener works without any generation worker. Run only one listener and one queue
worker per state directory.

The optional Compose `worker` profile is for an advanced container deployment.
It requires a reachable private Mac API, `mac-client.json`, an auditioned pool,
and either a Linux-compatible Codex binary/auth state under `data/codex/` or an
explicit per-story API policy. Those are not installed automatically. The
recommended Mac setup runs `node scripts/worker.mjs` on the host instead; do not
run both workers against the same queue.

## Back up and restore

Back up `.env` and all of `data/` to private storage. This includes provider keys,
passwords, tokens, source revisions, cast/reference history, audio, budget ledgers,
listener progress, device grants, and SQLite databases. Code alone cannot restore
a library or repair its recordings.

For a consistent filesystem backup, stop the host worker with Ctrl-C, wait for it
to exit, stop the Mac API if it is writing references, and run `docker compose down`
before copying state. Do not copy just a live SQLite main file and omit its WAL.
After the backup, restart the services. Prefer a tested encrypted backup system
with version retention; this repository does not install one.

Restore into an empty `data/` directory while all writers are stopped. Restore
`.env`, preserve restrictive permissions, and ensure the configured UID/GID can
read and write their mounts. Start the listener and inspect a known chapter's
reading text, audio seek, and saved progress before resuming generation.

## Moving from Audiobook System to Storyteller

The GitHub repository is now `benbernard/storyteller`. For an existing checkout:

```sh
git remote set-url origin git@github.com:benbernard/storyteller.git
```

The Compose project and image are now named `storyteller`. After backing up and
stopping generation, stop the previous containers before starting the renamed
project to avoid a port conflict:

```sh
docker compose -p audiobook-system down
docker compose build listener
docker compose up -d --wait listener
```

Keep the same `.env` and `data/` directory. Data paths, server routes, passwords,
paired devices, and Android application ID are unchanged. The Android launcher
and in-app name now read Storyteller. Retain your signing key and raise your
release version code when distributing an update.

## Updates and troubleshooting

To update code, stop generation, take a backup, pull the desired Git revision,
rebuild the Docker image and local TypeScript packages, and recreate Storyteller.
Keep model locks and recorded story revisions together. Review casting before
changing a model revision or replacing reference audio.

- **401 in the browser:** check the username/password and that `Host` matches
  `LISTENER_PUBLIC_URL`. The native API requires a paired token, not Basic auth.
- **403 on a browser action:** the browser origin must match the configured origin.
- **Permission denied or HTTP 500:** confirm both text and audio are readable by
  the service UID. Check listener state is writable. On Linux, setup records the
  invoking user's IDs; do not run setup as root and generation as another user.
- **Worker waiting:** check the Mac API, selected model, queue lease, and computer
  wake state. Busy/unavailable Mac jobs wait rather than switch to a paid provider.
- **Casting needs review:** inspect source evidence and the reference pool. Add a
  compatible reference or apply an explicit effective-position recast.
- **Writer lock remains:** verify the owning process/container has stopped before
  using CLI `unlock`. Removing an active lock can corrupt state.
- **Paid request outcome unknown:** inspect its private receipt and ledger before
  retrying. Keep the reservation until you know whether it was charged.

A repaired recording gets a new assembly ID. Old issue reports and listening
history keep the old assembly/timestamp. Do not delete old assemblies to save
space without accepting that those historical references will become unavailable.

## Optional author notes

In the web player, open **More** and clear **Include author notes** to remove tagged
notes from playback, scrolling text, chapter duration and the seeking timeline.
Android has the same choice in **Tools → Playback**, including lock-screen controls.
Both include notes by default and remember the choice on that device. Turning notes
back on restores them at the same story location. Chapter announcements and story
content remain visible and audible in either mode. Existing downloads are reused.
Saved locations still refer to the original recording so they work across devices
with different note settings. Audio and source text are unchanged.

**Jump to current place** restores the current passage's highlight and scrolls it
into view without moving the audio. Back 15 seconds counts included audio across
chapter boundaries. Automatic note skips and chapter advances do not replace the
Undo destination. An older Undo location inside a hidden note returns to the
preceding readable passage instead of skipping forward again.

Archived opening and closing note boxes already have timing tags. New analysis
also labels author commentary within chapter text, preserving source boundaries
and keeping notes separate from story passages. The player skips only identified
note ranges. Older recordings that mix notes and story within one timed passage
continue to play that passage in full.
