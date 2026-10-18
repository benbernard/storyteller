# Storyteller design review, round two

The owner rejected round one because it changed colors and small details while
keeping too much of the same app structure. This round explores four product
models. No layout is approved for implementation.

| Direction | Starting point | Navigation | Main tradeoff |
| --- | --- | --- | --- |
| Story canvas | Current chapter text | Chapter drawer and tools attached to passages | Browsing and production are secondary |
| Listening deck | Current listening session | Transport, queue, temporary sheets | Cross-book sessions need new product work |
| Visual shelf | Illustrated book collection | Open a book, choose a chapter or edition | Cover quality matters; issues are less visible |
| Studio desk | Book production project | Stage board and chapter inspector | Too much machinery for listening alone |

Each direction has separate markup and layout rules. The shared review wrapper,
sample story and buttons let the owner compare the concepts without changing the
live app. These are responsive web prototypes for Android and website discussion,
not native Android implementations. Dark/light variants and the full feature
inventory follow the direction decision.

## Build and verify

The source expects a cover-art sprite supplied as a file. The public artifact
manifest in homelab-config pins its uploaded URL, SHA-256 and size. Download and
verify that asset before building; do not add large artwork or screenshots to Git.

```sh
node docs/ui-review-v2/build.mjs .agent-scratch/ui-review-v2 /verified/path/cover-art-sprite.png
node docs/ui-review-v2/verify.mjs .agent-scratch/ui-review-v2
```

The build produces a self-contained HTML file with no external script, font,
service or audio dependency. The prototype makes no provider calls. Book titles,
chapter text, voices, budgets and production states are invented samples.

The verifier renders home and detail states for all four directions at phone and
desktop sizes, checks viewport overflow, and exercises the chapter drawer, text
tools, queue, timer, search, book details, studio review and feedback export.
Screenshots still need visual inspection; passing interaction checks alone does
not establish that two design directions differ enough.

Feedback uses browser-local storage under `storyteller-design-v2`. It is separate
from round-one notes. Export downloads Markdown for the owner to send back.
Nothing is submitted to a feedback server.

## Artwork provenance

The happy book icon is the original app artwork, restored separately. The cover
sprite was generated with the built-in image tool, not a paid API or CLI fallback.
Its source output was copied to the task workspace at
`.agent-scratch/ui-review-v2/cover-art-sprite.png` before use and publication.

Prompt: Create one portrait 2:3 cover-art sprite sheet divided into a precise 2×2
grid of equal portrait illustrations, full bleed, no borders, gaps or text. Top
left: white lighthouse on a dark rocky coast at dusk, golden beam, gouache, teal
and ochre. Top right: antique nautical chart dissolving into ocean waves, tiny red
sailboat, indigo and coral. Bottom left: luminous glass orchard with translucent
pear trees at sunrise, green and amber. Bottom right: midnight train through snowy
mountains under a crescent moon, blue-black and cream, linocut. These are invented
sample story worlds, not published book covers. CSS crops each quadrant without
altering the generated asset.
