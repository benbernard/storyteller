# Inworld API generation

Inworld is an optional paid speech provider. It does not require a local GPU, Breeze, or
Qwen installation. The engine uses the unary speech API per passage, keeping its
existing budget reservations, checksum cache, chapter assembly, resume, and repair
workflow. Chapter text is sent to Inworld; paid chapter analysis uses the separate
OpenAI API unless you import validated analysis.

## Credentials and models

Create an account and API credential in the
[Inworld Portal](https://platform.inworld.ai/). Copy the Base64 credential exactly
as provided into your private `.env` file:

```dotenv
INWORLD_API_KEY=your-portal-credential
```

Do not encode it again or include the `Basic ` prefix. The client adds that
prefix in the HTTP Authorization header. The listener never receives this key.
Keep `.env` and `data/` out of Git. See the
[official API contract](https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech)
for authentication, request fields, and current limits.

Supported models are `inworld-tts-2` and `inworld-tts-2-flash`. Choose actual voice
IDs available to your account; ElevenLabs IDs and local reference UUIDs do not
transfer. Audition at least a narrator, a separate anonymous speaker, and a
suitable dialogue pool. Match the narrator to the main character's gender when
established by the source. Check the provider's current rates and terms before
setting budgets or sharing recordings.

## Configure a pilot

Run the README setup and [import a chapter](importing.md). Copy
`tools/audiobooks/examples/fiction-inworld.json` to `data/input/inworld.json`.
Edit it before use:

- Set `fictionId` to the imported story and supply real narrator/anonymous IDs.
- Choose the analysis model, verified token prices, and call ceiling if using
  paid analysis. Otherwise import analysis with `analyze-import`.
- Set a positive verified `budget.usdPerThousandCharacters`, the maximum speech
  characters, dollar ceiling, and allowed attempts per segment. Both spending
  ceilings start at zero. Dollar estimates use your configured rate; they are
  not a live price lookup or a provider-enforced dollar limit.
- Keep `policy.maxCharacters` at or below 2000 UTF-16 code units. The example
  uses 1800. Each request uses one voice. `grouping: "scene"` can join adjacent
  spans only while that voice stays the same; `"turn"` keeps spans separate.
- Use `continuity: "none"` or `"text"`. Text context uses the preceding passage
  in Inworld's `synthesisContext.previousRequests`. Request-ID stitching is
  unsupported. `seed` is unused by this adapter. Leave it `null`.

```sh
export FICTION_ID=my-book
docker compose run --rm cli configure --file /input/inworld.json
```

The shared voice schema retains ElevenLabs settings for compatibility. Inworld
uses only `settings.speed`, sent as `audioConfig.speakingRate`; stability, style,
similarity, and speaker boost are not sent. Requests use MP3 at 44.1 kHz/128 kbps.
The full model uses `deliveryMode: "BALANCED"`. Flash omits delivery mode. Text
normalization maps to Inworld's ON/OFF/default enum. Use the local pronunciation
`dictionary` for substitutions. ElevenLabs dictionary IDs and v3 delivery tags
are rejected. Streaming, long-form async jobs, provider batch pricing, and Inworld
inline acting controls are not exposed by this adapter.

## Audition, prepare, and generate

Create `data/input/inworld-audition.json`:

```json
{
  "voice": {
    "voiceId": "YOUR_INWORLD_VOICE_ID",
    "settings": {
      "stability": 0.5, "similarity_boost": 0.75,
      "style": 0, "use_speaker_boost": true, "speed": 1
    }
  },
  "text": "The lantern flickered. We should leave before dawn.",
  "model": "inworld-tts-2"
}
```

```sh
docker compose run --rm cli audition --batch inworld-pilot --file /input/inworld-audition.json
```

This spends speech credits within the pilot's ledger. Listen to the returned asset
and add accepted voices to `pool` in your book configuration, including the
returned `sampleAsset`, source-supported portrayal tags, rating, reviewer, and
notes. Follow the [paid casting guide](paid-generation.md#audition-and-save-the-evidence)
for those fields. Use one pilot batch ID for all auditions sharing its budget.
Repeat with Flash if comparing models. The `experiments` command compares
ElevenLabs policies and rejects an Inworld configuration.

```sh
docker compose run --rm cli configure --file /input/inworld.json
docker compose run --rm cli prepare --batch inworld-pilot --chapters CHAPTER_ID
```

**Prepare may spend OpenAI analysis credits.** Review its preview and speaker
assignments. Record your listening decision in `policy.listeningEvidence`, set
`selectedAfterListening: true`, then reconfigure and generate a new batch:

```sh
docker compose run --rm cli configure --file /input/inworld.json
docker compose run --rm cli run --batch inworld-first --chapters CHAPTER_ID
docker compose run --rm cli publish --batch inworld-first --edition inworld \
  --title 'My book' --author 'Author'
```

For Flash, select `inworld-tts-2-flash` in the config and use edition
`inworld-flash`. Edition names check the recorded model. Listener and Android show
these alongside other published editions. Use `export` for MP3s and an M3U playlist.

## Resume, costs, and provider changes

Repeat an interrupted `run` with the same batch and unchanged inputs. Completed
assets are verified and reused. Changed models create different cache identities.
The ledger reserves estimated cost before each request and records Inworld's
reported processed-character count when supplied. This is usage evidence, not an
invoice. Network outcomes with uncertain billing are not silently retried.
Retryable HTTP errors consume another reservation within the configured attempt
and budget ceilings. Apply account-level limits at the provider too.

[Timestamp repairs](paid-generation.md#resume-and-repair) work with this provider.
Publish the repair to the same Inworld edition after listening. Previous
assemblies and issue timestamps remain available.

Use a new batch after changing the model, source, policy, or cast. When switching
from another provider, use a separate fiction state or explicitly review every
saved cast voice version before generating: saved ElevenLabs voice IDs are not
converted to Inworld voices. Keeping a different edition name alone does not
recast characters. There is no automatic provider fallback.

Tests use injected API responses and synthetic audio. They check request headers,
UTF-16 limits, response decoding, usage, budgets, cache reuse, and publication.
They do not establish live account access, current prices, or speech quality.
