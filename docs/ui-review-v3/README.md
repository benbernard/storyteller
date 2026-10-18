# Storyteller: Shelf × Deck

The owner liked round two's Listening deck and Visual shelf, and asked for more
mixes and other ideas. Beauty and usability are equal requirements. This round
keeps the illustrated collection and playback controls while changing how they
fit together. No final app layout has been approved.

| Concept | Home screen | Player placement | Main tradeoff |
| --- | --- | --- | --- |
| Shelf & dock | Cover-led library | Small persistent dock, expanded deck | More playback controls need one extra tap |
| Side by side | Library and player together | Side panel on desktop, compact panel on phone | Small-screen density needs care |
| Cover stage | Current book and listening session | Main screen | Browsing lives in a collection sheet |
| Chapter journey | Current book and chapter path | Attached chapter player | Collection browsing takes another step |

The first three mix the preferred directions. Chapter journey is an additional
idea for keeping a strong sense of place within a book. Preparation, provider
settings and budgets belong behind book tools, outside everyday listening.

## Build and check

Use the pinned repository pnpm version. This small package provides official
Phosphor icons for the review only. It does not change app dependencies.

```sh
pnpm -C docs/ui-review-v3 install --frozen-lockfile
node docs/ui-review-v3/build.mjs .agent-scratch/ui-review-v3 /verified/path/cover-art-sprite.png
node docs/ui-review-v3/verify.mjs .agent-scratch/ui-review-v3
node docs/ui-review-v3/overview.mjs .agent-scratch/ui-review-v3
```

The cover sprite is the same generated asset as round two. Its SHA-256 is
`81f11788633e3ea9a8d60c292e8975805f8643398f7abb4ec1bbb0e15eac7502`.
The private homelab-config review manifest pins its verified public NAS URL.
The original prompt and generation provenance remain in `docs/ui-review-v2/README.md`.
The happy book icon is the restored original. The HTML embeds these assets and
the Phosphor MIT license, so it needs no external script, font or service.

Local checks render all four concepts at phone and desktop sizes in both
appearances. They measure palette contrast and inspect viewport overflow.
Interaction checks cover book and chapter selection, in-place player updates,
expanded playback, seeking, queue editing, timer, author-note preference, search,
empty state, local comments and export. Large text is checked at a narrow width.
Review screenshots manually before delivery. These checks do not establish full
native Android accessibility or complete app feature coverage.

The examples use invented books, text, voices and progress. Buttons change
sample state. There is no audio stream, source import, provider submission or paid
operation. The download control changes sample state without fetching a file.

## Review feedback

Comments are saved per concept in browser-local storage at
`storyteller-design-v3`. The owner can export Markdown and send it back.
Round-one and round-two feedback remain separate. No comment is uploaded to a
feedback service, and selecting a prototype does not change the app.

The product search initially returned a marketing landing pattern that did not
fit this app. A narrower media-player search supported artwork-led playback and
dark media surfaces. Its landing-page recommendations were discarded. Native
touch, focus, contrast and text-layout guidance informed the prototype controls.
