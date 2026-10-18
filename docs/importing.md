# Import a story

Run commands from the repository root after the README setup. Keep source files
under `data/input/`; Compose mounts that directory at `/input` for the CLI.
Generated chapter files and exports stay under `data/` and are ignored by Git.

## Royal Road

Supply a public fiction URL or numeric ID:

```sh
docker compose run --rm downloader inspect https://www.royalroad.com/fiction/12345
docker compose run --rm downloader download https://www.royalroad.com/fiction/12345
```

Replace `12345` with the story's actual ID. The downloader writes
`data/archive/rr-12345/chapters.json`, source revisions, HTML, and checked images.
Repeat `download` to fetch missing chapters. Use `--from 1 --to 2` for a small
pilot, `--refresh` to check saved chapters, or `--reprocess` to extract saved HTML
again. Bounds refer to positions in the current table of contents.

The downloader spaces requests and stops after bounded retries. If the site
requires a challenge, login, or a long cooldown, stop and obtain an authorized
text export. This package does not bypass access controls or import private
browser sessions.

To export the saved story as an EPUB:

```sh
docker compose run --rm downloader epub 12345
```

The JSON result names the saved edition beneath the story's archive directory.
Downloading and EPUB export do not call an AI provider.

For [Breeze](breeze.md#import-chapters-and-initialize-one-job), import the saved
JSON with `scripts/breeze.mjs import`. For the paid engine, use a configuration with `fictionId: "rr-12345"` and import:

```sh
export FICTION_ID=rr-12345
docker compose run --rm cli ingest --file /archive/rr-12345/chapters.json
```

For automatic local generation, use Storyteller's **Tools → Source library** to
follow the story after completing the local worker setup. Download-only follows
need the worker too, but do not load a speech model or call analysis.

## EPUB, PDF, or TXT

Copy a book to `data/input/book.epub`, then convert it:

```sh
docker compose run --rm --entrypoint node cli dist/import-file.js \
  --file /input/book.epub --fiction my-book --output /exports/my-book-chapters.json
```

EPUB imports follow spine order and preserve paragraph breaks. PDF imports use
`pdftotext` and turn pages into chapters; scans without selectable text need OCR
first. TXT imports preserve exact UTF-8 text as one chapter. Large books should be
split into sensible chapters before analysis. Encrypted EPUB text is rejected.
The output must be a new file.

Import the result into the paid engine:

```sh
export FICTION_ID=my-book
docker compose run --rm cli ingest --file /exports/my-book-chapters.json
```

For manual local generation, ingest the same JSON with the CLI, import or prepare
validated analysis, then use the local renderer described in the local guide.
Automatic arbitrary-file watching is not included; automatic follows use Royal
Road URLs. The original BookOrbit selection socket is an optional integration.

## Chapter JSON

For a custom source, emit one record or an array with these fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1` |
| `fictionId`, `chapterId` | Stable letters/digits/underscore/hyphen identifiers |
| `sequence` | Positive integer in reading order |
| `url` | Absolute source URL |
| `title` | Chapter title |
| `text` | Exact text, including whitespace and punctuation |
| `retrievedAt` | ISO UTC timestamp |
| `contentHash` | SHA-256 of the UTF-8 bytes of `text` |

Inspect the complete schema or calculate a hash:

```sh
docker compose run --rm cli schema --kind chapter
docker compose run --rm cli hash --file /input/chapter.txt
```

`tools/audiobooks/examples/chapter.json` is an original scene. Importing identical
text reuses its source revision. Changed text creates a new revision; published
chapters require a reviewed repair before automatic audio replacement.
