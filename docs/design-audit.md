# Listener: approved-design parity audit

The owner required a complete comparison against the approved mocks after the
first release was published. Functional tests and release receipts alone
did not establish visual parity. This audit covers the actual Android client and
website, using the approved mock and decision record as the reference.

Baseline public source: `9fc34c476ce75b2c9f066c1e221b8f5d84283306`.
The latest mock HTML has SHA-256
`08017fabcd62f89ee1fc315550840f408e2d2f6878c45974bb00c2387cca8f9a`.
The [approved book/account mock](https://files.crabanddog.com/general/public/agent-uploads/report-deec03d1f23c45e1813fed6dcc537b8d/storyteller-design-review-v3.html?review=account-r2) and [approved listening mock](https://files.crabanddog.com/general/public/agent-uploads/report-deec03d1f23c45e1813fed6dcc537b8d/storyteller-listening-r17.html) are the reference. Earlier rejected concepts in `docs/ui-review-v3` do not supersede these approvals.

Status: local design comparison complete for product source
`bf3d4bd15b2a9f22b4ea7a8a9a82df37a51515d3`. The checks below record an agent
review against the approved references. They do not assert that a deployment or
app publication has completed. Native system controls and browser-managed
authentication follow their platform contracts.

## Shared visual system and navigation

- [x] Match the approved light and dark palette, including paper, ink, mint,
  teal, muted text, borders, focus, and modal scrim.
- [x] Preserve the original mascot, its proportions, header size, and placement.
- [x] Match the compact type hierarchy, weights, line heights, and spacing.
- [x] Use the same Material icon shapes, visible sizes, and unboxed controls.
- [x] Retain 48 dp Android targets and accessible control names and states.
- [x] Put icon-only Back at the far left before the mascot on every inner page.
- [x] Header Back and Android/browser Back use the visited stack and dismiss
  open sheets first, preserving query, filter, scroll, playback, and drafts.
- [x] Match mini-player cover, book/chapter identity, spacing, and Play/Pause.
- [x] Verify phone, narrow/large-text, landscape, and expanded layouts in both
  appearances, including keyboard focus and reduced motion.

## Library

- [x] Match header actions and their placement, including Account on library/book
  pages and the compact Listening header.
- [x] Match compact search with search icon, title/author hint, and Clear.
- [x] Match plain underline filters: `All`, `In progress`, `Not started`.
- [x] Match Keep listening heading and mint card: larger cover, identity,
  current chapter/time, remaining duration, Play, and book menu.
- [x] Match More stories/Your books heading and result count.
- [x] Match ordinary rows: 48×72 cover, title, author, place, unread/remaining
  metadata, repair/preparation state, and appropriate menu.
- [x] Ordinary rows open Book. Keep the primary Play/Continue on Book.
- [x] Preserve per-book place and current-book identity after switching books.
- [x] Match loading, empty, no-result recovery, refresh failure/retry, and saved
  offline library states without removing previously available audio.
- [x] Preserve search, filter, and scroll through Book, Listening, and Back.

## Book

- [x] Match centered 88×132 cover, centered title and author.
- [x] Match full-width Play book/Continue listening directly below identity.
- [x] Keep unavailable audio disabled with its explanation.
- [x] Match serif description and separated Your place, Audio, Remaining facts.
- [x] Match compact Chapters, Downloads, Marked issues, Audio preparation links.
- [x] Explain which download features are available on the website.
- [x] Preserve Book scroll when returning from child pages and Listening.

## Chapters and text browsing

- [x] Match book heading, Chapters/edition subtitle, search, and explanatory copy.
- [x] Match chapter number column, title/status hierarchy, current mint row,
  and separate icon-only Play/Resume target.
- [x] Title opens text without moving or starting audio; Play starts a different
  chapter at its beginning. The current chapter resumes its current place.
- [x] Match finished/not-started/current/unavailable/offline rows.
- [x] Unavailable audio remains readable and cannot replace current playback.
- [x] Preserve query and scroll through browsing and Back.
- [x] Label browsed text separately while the top header identifies actual audio.
- [x] Include previous/next chapter browsing at the end of the reader.

## Listening

- [x] Match three-level header: book, chapter number/count, chapter title.
- [x] The chapter heading opens Chapters. Settings remains at the right.
- [x] Match serif reading size, line height, paragraph spacing, width, and insets.
- [x] Match mint current-paragraph treatment and slim teal left edge while
  preserving exact text order and passage-level seek semantics.
- [x] Show full surrounding text and permit free scrolling independently of audio.
- [x] Match context row above timeline with Following/Browsing text, Back to audio,
  compact Undo when relevant, Mark issue, and Recent jumps.
- [x] Back to audio only follows/scrolls. Selecting text seeks.
- [x] Match timeline above elapsed/total times.
- [x] Match five-slot transport order: speed, original Back, centered 40 px
  Play/Pause circle, original Forward 30, audio output.
- [x] Keep playback centered when Undo appears. Avoid a second toolbar row.
- [x] Retain playing/paused intent through seeks, edition changes, and loading.
- [x] Audio output opens the real system/browser chooser or honest fallback.

## Listening settings and speed

- [x] Match compact 360 px sheet, 16 px radius, header title/Close, and body insets.
- [x] Match Playback/Include author notes first, with no helper subline.
- [x] Match Audio edition heading, same-passage helper, and horizontal choices.
- [x] Edition changes keep the same passage and playback intent. Unavailable or
  unmapped choices retain current recording, place, and an inline retry/error.
- [x] Match Reading text size, A− / percentage / A+, and the approved example.
- [x] Preview uses the reader's selected font, size, and line height.
- [x] Match speed −0.1 / active value / +0.1 stepper.
- [x] Match every tenth from 0.8× through 2.5× and explicit Custom selection.
- [x] Match custom entry, hint, Apply speed/Enter, and inline invalid-entry error.
- [x] Dismissal discards unapplied input. Changing speed never seeks or pauses.
- [x] Close, backdrop, Escape, and Back dismiss the appropriate sheet.
- [x] Preserve author-note clock, seek, completion, and decoded-output behavior.

## Downloads and book menu (Android)

- [x] Match cover/identity header, edition/On this phone subtitle, offline toggle,
  future-chapter explanation, count, progress, bytes, and current transfer.
- [x] Match ready/empty/downloading/paused/Wi-Fi/connection/storage/failure states.
- [x] Match Pause/Resume/Retry and explicit failed audio/text records.
- [x] Match settings: download edition, Wi-Fi only, 2/8/32 GB phone limit.
- [x] Download edition changes never alter playback edition or seek.
- [x] Match visible per-book menu and long press, including Downloads shortcut.
- [x] Match named Clear downloads confirmation and Keep downloads cancellation.
- [x] Clearing affects this account/book across editions on this phone, pauses
  only that book, preserves listening place, other books, and shared audio.

## Mark an issue

- [x] Match compact sheet/header, book and chapter/time/edition context.
- [x] Match serif excerpt with teal left edge and inline failure treatment.
- [x] Match Problem selector, five labels, Delivery or pacing default.
- [x] Match optional note, 2,000-character limit, Discard draft, Save issue.
- [x] Capture actual audio place while browsing and pause immediately, including
  pending autoplay. Closing or saving never resumes playback automatically.
- [x] Closing/process restart preserves the per-book draft and captured location.
- [x] Local-save failure keeps the form. Offline sync keeps one stable report.

## Marked issues

- [x] Match title, book/all-books selector, All/Open/Resolved filters.
- [x] Match empty, saved/offline, view-only, and refresh failure states.
- [x] Match row type, book, chapter/time/edition, excerpt/note, and separators.
- [x] Put an empty/filled checkmark in the former status position. No Open label
  or marked-resolved message remains.
- [x] Fill only after confirmation. Failed updates retain prior state and retry.
- [x] Disable writes for offline, pending local reports, and view-only accounts.

## Recent jumps

- [x] Match compact sheet, book identity, explanation, row hierarchy, excerpts,
  time/edition/when, and icon-only Return here action.
- [x] Record departures automatically. No Save place control or checkpoint noise.
- [x] Browsing and edition changes do not add jumps. Preserve permanent paging.
- [x] Return uses original recording/place and retains playing/paused intent.
- [x] Dismissal cancels pending return. Failed return retains current audio.
- [x] Match empty/offline/unavailable/failure states. Offline return requires
  verified audio and its text.

## Preparation

- [x] Match cover/identity header and Qwen local/Audio preparation subtitle.
- [x] Match published count/progress summary, job panel, chapter disclosure,
  automatic-checks row, last-report time, Refresh status, and settings icon.
- [x] Queued/preparing/publishing never increase published count.
- [x] Distinguish cancellation requested from confirmed cancelled. Retry means
  queued work, with existing published audio still available.
- [x] Match offline/view-only/unsupported states and reported-state freshness.
- [x] Match compact settings, checks toggle, Prepare selection, explicit Save,
  failed-save draft, and dismissal without saving.
- [x] Pausing automatic checks leaves current job running. Scope stays on book.

## Sign in and account

- [x] Match first-open mascot, heading, copy, compact Sign in, and spacing.
- [x] Match browser-pending Continue sign in/Cancel and timeout/retry/error states.
- [x] Use real identity-provider browser sign-in and verified app-bound return;
  do not introduce code pairing, device approval, or mock browser UI.
- [x] No autoplay after sign-in. Cancellation/process recovery retain isolation.
- [x] Match Account identity, phone scope, sync status, and Sign out entry.
- [x] Match sign-out confirmation, Stay signed in, and pending-work handling.
- [x] Clear account data only after sync/revocation succeed. Failure preserves
  work and other devices stay signed in.

## Excluded proposals

- [x] No sleep timer, global Offline/Tools overview, Characters encountered,
  Add a story/import UI, source-book selection, or narrator/cast setup.
- [x] Existing-book preparation and agent-side ingestion remain available.
- [x] No review notes, synthetic completion buttons, scenario menus, invented
  accounts/devices, or approval simulator controls appear in the application.

## Comparison evidence

The [comparison gallery](https://files.crabanddog.com/general/public/repository-assets/listener-design-evidence/6c0bd648738795277be3b0a24326628c747ef607044b0c4ca5b62e2edd640b5a/files/review-20261022/index.html)
contains 56 screen/state comparisons. It includes the approved reference,
Android and web captures, manifests and checksums. Every account, book and report
shown is fictional. The gallery identifies captures that do not apply to a
platform instead of counting them as passes.

| Flow | Main capture |
| --- | --- |
| Library, filters and book menu | `01-library`, `state-book-menu` |
| Book details and primary Play | `02-book` |
| Chapters and browsing without moving audio | `03-chapters`, `04-browsing-next` |
| Listening while paused, playing and after a jump | `04-listening`, `state-listening-playing`, `state-listening-playing-with-undo` |
| Edition, notes and reading size | `05-listening-settings` |
| Preset and custom speed | `06-speed`, `06-speed-invalid` |
| Recent jumps and return failures | `07-jumps`, `state-jumps-offline-failure` |
| Captured issue draft and save failure | `08-mark-issue`, `state-issue-save-failure` |
| Downloads and per-book clearing | `09-downloads`, `state-clear-downloads-confirmation` |
| Download edition, Wi-Fi and storage | `10-download-settings` |
| Reports, resolution, empty and read-only states | `11-marked-issues`, `state-issues-view-only` |
| Preparation, cancellation and publication states | `12-preparation`, `state-preparation-cancellation-requested` |
| Preparation settings and failed save | `13-preparation-settings`, `state-preparation-settings-save-failure` |
| Account and sign-out confirmation | `14-account`, `15-sign-out` |
| Sign-in entry and browser return | `16-sign-in`, `17-sign-in-browser` |
| Real Android audio-output selector | `state-system-audio-output` |

The reader comparison checks the three-level header, full surrounding text,
current paragraph, follow/browse state, timeline and total duration, compact Undo,
original skip icons and centered Play/Pause. Skip icons are 22 px, Play/Pause is
26 px inside a 40 px circle, and History is 22 px. Android retains 48 dp touch
targets around these smaller visible icons.

## Validation

- 39 Android unit tests and Android lint passed.
- 24 native design checks passed across phone, 320 dp at 200% text, landscape at
  200% text and expanded dark layouts. These render the actual app composables
  with fictional state, including playing and Undo.
- 37 native layout/playback/storage checks passed across four layouts. The
  cover-cache test also passed, including offline use and account isolation.
- The private package integration passed the same 37 native checks and debug
  and release lint. Its product Kotlin and resources come from this repository.
- Browser playback/persistence tests and the design matrix passed at 320, 390,
  840 and 1440 px, large text, landscape, dark appearance and reduced motion.
  Loading, offline, permissions, failed-save and cancellation cases passed.
- The [public Checks workflow](https://github.com/benbernard/storyteller/actions/runs/39788862614)
  passed for the exact product source above. The merged tree is identical.

The comparison corrected the original palette and hierarchy, oversized controls,
reader spacing, missing book identity and secondary-flow differences. It also
found and corrected clipped Recent jumps rows, a browser sheet-close/Back race,
and a reader follow offset that could hide the active text in a short landscape
window. Tests now scroll virtualized content into view before inspecting it.

A subsequent read-only check of published chapter structure found a blank line
split across two recording segments. The browser now identifies paragraphs in
the joined text, retaining each fragment's original passage and seek time.
Android already used joined text. Two unit regressions and a browser regression
cover split words, split blank lines, hidden author notes and exact seek targets.
These checks supplement the linked captures from `bf3d4bd`; they do not relabel
those images as captures of a later commit.

The private candidate check also exposed a report refresh race after an offline
issue synced. Refresh now waits for an existing queue flush and updates the open
reports page when the server state arrives. A delayed-response regression checks
that the saved report becomes actionable without reopening the page.

## Platform differences and limits

Android uses native font metrics, nonlinear text scaling, native form/range
controls, system bars and accessible touch targets. These change some line breaks
and control rendering. The approved palette, layout, hierarchy, icon geometry and
flow are retained. System audio routing uses the real Android device panel.
Bluetooth hardware handoff has not been tested on a physical device.

Downloads and app sign-out are Android functions. The website keeps its existing
browser-managed sign-in and explains its download limitations. The browser uses
an output chooser where supported and otherwise directs the user to system
sound settings. Offline cover/audio/text storage and account cleanup are tested
separately from the fictional visual captures.

Capture and gallery tools are in `scripts/capture-design-reference.mjs` and
`scripts/design-review-report.mjs`. Reproduce the checks using
[design verification](design-parity.md). The capture tools check both approved
HTML hashes and do not change the approved mock to match the app.
