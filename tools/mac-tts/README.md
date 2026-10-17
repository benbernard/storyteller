# Mac speech API

Start with [local generation](../../docs/local-generation.md). The standalone
installer prepares MLX and native Qwen environments; other adapters require their
matching runtime. `GET /v1/capabilities` publishes validated input options.

The API supports model switching, queued inference, persistent references and
voices, job cancellation, audio download, and worker leases. It binds to loopback
by default and requires a private bearer credential for every request. Do not
expose it as a public service.
