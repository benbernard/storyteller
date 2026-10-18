# Storyteller design directions

These interactive concepts explore a simpler interface before changing the
application. They use fictional books and an original short reading sample.
Playback, reports and audio preparation are simulated. No account, provider or
production endpoint is contacted.

## Current interface

The Android app has Library, Listening and Tools destinations. The web listener
uses Library, Reading and Tools. Story detail offers chapter selection alongside editions
and preparation controls. Tools combines following stories, preparation jobs,
location history, marked issues and playback preferences. Android puts the
author-note setting in Tools. The web player puts it under More.

The review should test whether those groupings match the listener's expectations.
Edition names and preparation states also need plain explanations. These are
design hypotheses from the current code, not results from a usability
study.

Preserve exact read-along text, saved positions and undo, spoiler-aware character
information, offline downloads, author-note preferences, issue timestamps and
existing account pairing. A visual redesign must keep those capabilities.

## Three directions

| Direction | Main idea | Strength | Tradeoff |
| --- | --- | --- | --- |
| A. Bookshelf | A familiar library with a prominent resume action | Approachable everyday listening | Preparation is less prominent |
| B. Listening room | Open to the player and reading pane | Fewer distractions during listening | Comparing books takes another move |
| C. Two spaces | Separate Listen and Make | Clear homes for playback and production | Adds an explicit choice of workspace |

Each includes library, player and preparation examples, with phone and wide-screen
layouts and light and dark appearances. The prototype lets reviewers select a
direction and keep notes. Notes remain in that browser until downloaded or copied.
There is no feedback submission service.

The smiling book and turquoise headphones are the original artwork from commit
`b469add`. Android launcher resources are restored byte-for-byte, including all
five densities and the adaptive monochrome layer. The in-app and web marks use
the original mascot. These are the exact original files.

## Build and inspect

From the repository root:

```sh
pnpm -C tools/audiobooks install --frozen-lockfile
node docs/ui-review/build.mjs .agent-scratch/ui-review
node docs/ui-review/verify.mjs .agent-scratch/ui-review
```

The builder creates a self-contained HTML file. The browser checks cover 36
screen, width and appearance combinations, along with search, transport, seeking,
author-note selection, feedback persistence, export, keyboard focus and large
text. Screenshots and verification output go into ignored task scratch. Keep
published image collections outside Git and retain their checksums and links.

The examples are responsive web prototypes of the proposed app workflows. Native
Android changes and validation follow after a direction is selected.

## Page review order

After choosing a direction, review one area at a time:

1. Library, search and resume.
2. Story detail, editions and chapter readiness.
3. Player, read-along, chapter navigation and mini-player.
4. Playback preferences, author notes and text size.
5. Downloads and offline use.
6. Add a book, follow a story and import text.
7. Preparation progress, automation, budgets and recovery explanations.
8. Marked issues, location history, undo and character information.
9. Account connection, sync, updates and accessibility.

For each area, agree on the main task, required information and secondary actions
before building it. Preserve a decision log as feedback arrives.
