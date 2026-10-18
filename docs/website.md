# Public demo and landing page

[Storyteller on GitHub Pages](https://benbernard.github.io/storyteller/) lets people
compare Breeze, Qwen, and Inworld without installing the system. It has a
read-along transcript, screenshots of the listener, setup commands, and links to
the engine guides.

The site is static. Its only recordings are the credited sample under
`samples/maltese-falcon/`. The Pages build copies an explicit list of public
files, checks the sample manifest, and creates `.site-output/`. It never reads
the ignored `data/` directory.

## Edit and check locally

```sh
pnpm -C tools/audiobooks install --frozen-lockfile
pnpm -C tools/audiobooks exec playwright install chromium
pnpm test:site
python3 -m http.server 8090 --directory .site-output
```

Open <http://localhost:8090/>. The browser check also serves the site under
`/storyteller/`, matching GitHub's project-site path. It checks five viewport
widths, playback of all three recordings, keyboard passage seeking, copyable setup
commands, asset loading, and the audio/download fallback without JavaScript.

The app screenshots show the bundled Maltese Falcon sample in a local Storyteller
listener. They include the edition picker and desktop/mobile read-along screens.
Keep them current when the listener changes.

## Publication

`.github/workflows/pages.yml` builds and checks the site on relevant pushes and
pull requests. A successful build from `main` deploys through GitHub Pages.
The repository uses **GitHub Actions** as its Pages source.

The artifact contains only `index.html`, its CSS/JavaScript, the chosen icon,
listener screenshots, sample media/metadata, and a revision receipt. Audio stays
on the same origin as the player. The sample's source attribution, voice
provenance, model/provider terms, and automated review notes remain linked.

To publish a fork, enable GitHub Pages with GitHub Actions as the source, and
replace this repository's absolute GitHub/Pages links with your fork's URLs.
The site assets and media use relative paths.
