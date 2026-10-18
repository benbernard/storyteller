# Third-party components

First-party code and documentation use PolyForm Noncommercial 1.0.0. That license
does not replace the licenses of dependencies, model weights, runtimes, or tools.

The generated Gradle wrapper (`gradlew`, `gradlew.bat`, and
`gradle-wrapper.jar` under `android/audiobook-listener/`) is from Gradle 8.13 and
uses the [Apache License 2.0](LICENSES/Apache-2.0.txt). Its source is available from
[Gradle](https://github.com/gradle/gradle/tree/v8.13.0). Preserve those file headers
and the Apache license when redistributing it.

Node dependencies are pinned by each package's `pnpm-lock.yaml`. Python runtimes
are pinned by `tools/mac-tts/requirements-*.lock`; Git source pins and model
revisions appear in those locks and `models.lock.json`. Android dependencies are
declared in the Gradle build. They are downloaded during installation/build and
are not vendored in this repository. Consult their packaged license notices when
redistributing a built application or image.

Model weights are not included. Review the applicable model repository and its
license before download or use, especially when changing deployment or sharing
recordings. The first-party noncommercial license grants no extra rights to
third-party models, books, reference voices, or service accounts.

The cached Breeze depth-decoder adapter
(`tools/mac-tts/acting-auditions/breeze_fast.py`) adapts the algorithm from
[xzf-thu/BreezeTTS2_Mac_Streaming](https://github.com/xzf-thu/BreezeTTS2_Mac_Streaming)
under Apache 2.0. Its attribution and full upstream license are retained beside
it in `breeze-fast-NOTICE.txt`. The adapter remains under Apache 2.0; the
repository's first-party license does not replace that notice.

Breeze code and model weights have different terms. The
[Breeze TTS 2 model repository](https://huggingface.co/BreezeBlue/Breeze-TTS-2)
describes the research/noncommercial model license, including terms for
derivatives and self-hosted output. Review those terms separately. Neither this
package nor its PolyForm license grants permission to use model weights outside
their own license. Inworld and ElevenLabs access and output also remain subject
to the provider terms.

The bundled Maltese Falcon excerpt is United States public-domain source text,
not first-party prose. The new synthetic recordings have separate model/provider
conditions. See [the sample rights and provenance](samples/maltese-falcon/README.md#source-and-rights).
The Bookwave mark was generated for this project; see [branding](docs/branding.md).
