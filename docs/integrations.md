# Running Storyteller with your own integrations

The public Storyteller repository defines the audiobook formats, generation jobs,
playback, web interface and Android screens. A deployment can supply login, library connections and app
updates without editing those features.

## Accounts and permissions

`createListener` accepts a `BrowserOwner` callback. It must return a stable storage
account ID after authenticating the request, or `null`. Keep that ID unchanged
when replacing your login provider: progress, history, jobs and paired devices
belong to it. An email address is safe as a legacy storage key only when explicitly
mapped from an authenticated, immutable provider identity.

The seventh argument accepts `ListenerIntegrations`. Its `permissions(account)`
callback applies to browser requests and existing paired devices on every request.
The server enforces listening, library management and generation permissions before
writing jobs. The default household owner can listen, manage the library and queue
local generation. Paid generation is not exposed through the listener API; it
requires the operator's explicit CLI plan, budget and credentials.

`GET /listen/capabilities` and `GET /api/listener/capabilities` return the account's
permissions, available source and generation adapters, update mode and source
revision. These responses require authentication. Capabilities describe configured
features. The permission callback remains the authority for access.

The supplied Basic and Authentik adapters are examples of the same account contract.
Authentik requires the pinned provider identity, exact proxy peers and expected
host. Do not accept identity headers from arbitrary network clients. Strip incoming
identity headers at the edge before trusted middleware sets them.

## Library and generation connections

File import and Royal Road work without BookOrbit. Set `BOOKORBIT_PUBLIC_URL` to
your BookOrbit HTTPS origin when enabling its optional selection socket and book
mount. New links use that origin; existing source records and their hashes stay
unchanged. Keep socket permissions, account mapping, mounts and credentials in
your deployment configuration. The socket adapter retains stable `bo-*`/`rr-*`
story IDs and the existing queue format.

`LISTENER_GENERATION` is an optional comma-separated list of available workers,
for example `breeze,qwen`. It advertises availability and does not start a worker.
The automatic library worker currently generates Qwen editions. Breeze and paid
Inworld editions use their documented book/CLI workflows. A disconnected local
worker waits. It never selects a paid provider as a fallback.

## Android composition and updates

The Android app's `app/build.gradle` loads `app/configure.gradle`. A private host
can apply the same configuration, point its Java, resources and tests at the
public source, and add a manifest overlay and an optional `:app-updates` library.
The public app works without that module. `-PlistenerUrl=https://your-host` sets
the endpoint. `-PstorytellerApplicationId=your.package.name` sets the install ID.

For an existing installation, keep its application ID, signing key, updater slug,
verified link and version-code sequence. A different application ID installs a
second app and cannot migrate an existing app's private data. Keep private update
feeds and fleet services in the host module; do not loosen their download-host,
checksum, package, version or signer checks.

## Bringing public changes into a private deployment

Pin a reviewed public commit and its source archive checksum. Run public tests
without private credentials, then run private compatibility checks against that
pin. Never run an untrusted pull request with private credentials. Build the
backend and Android host from the same pin and record it with the release.

Before changing production, copy state consistently, verify existing account and
device mappings, and compare library and queue identities. Stop the old worker
before starting its replacement. Preserve queue leases, budget ledgers and unknown
paid request outcomes. Keep the old image and configuration for rollback; do not
restore an old database over writes made after cutover.

## Optional OpenAI gateway

An operator can keep OpenAI authentication in a gateway. Set `AI_GATEWAY_ORIGIN`
to its HTTPS origin, `AI_GATEWAY_CLIENT_ID` to a stable source name, and
`AI_GATEWAY_USER_ID` to the authenticated owner's lowercase email. Supply a scoped
service credential through `AI_GATEWAY_TOKEN_FILE` or `AI_GATEWAY_TOKEN`.
These settings contain no backing provider API key or ChatGPT refresh token.

The gateway must support `/ai/openai/api/v1` for metered requests and
`/ai/openai/subscription/v1/responses` for ChatGPT subscription requests. Each
request carries `Authorization`, `X-AI-Client-ID` and `X-AI-User-ID`.
A configured gateway requires all three identities and never falls back to a
local provider key. Without these gateway settings, standalone installations
retain the existing OpenAI API key or local Codex subscription setup.

Chapter analysis and speech auditions keep their selected models, output limits,
reservation ledgers and retry rules. Subscription chapter analysis uses streaming
Responses with high reasoning and the existing output schema. A failed or
incomplete subscription response never switches to metered API billing.
The gateway should record provider usage and pricing separately from the local
budget ledger; a budget reservation is not a provider charge.
