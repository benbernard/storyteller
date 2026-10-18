const audio = document.querySelector('#sample-audio');
const passageRoot = document.querySelector('#passages');
const status = document.querySelector('#sample-status');
const editions = {
  breeze: {name: 'Breeze', duration: '1:16', note: 'Original synthetic voices designed with Breeze.'},
  qwen: {name: 'Qwen', duration: '1:16', note: 'The same synthetic voice references, rendered with Qwen.'},
  inworld: {name: 'Inworld', duration: '1:25', note: 'Inworld stock voices: Blake, Conrad, Wade, and Camille.'},
};
let timeline = [], active = -1, revision = 0;
const cache = new Map();
function highlight() {
  const index = timeline.findLastIndex(p => p.start <= audio.currentTime + 0.005);
  if (index === active) return;
  passageRoot.children[active]?.removeAttribute('aria-current');
  passageRoot.children[index]?.setAttribute('aria-current', 'true');
  active = index;
}
async function choose(edition) {
  const current = ++revision, selected = editions[edition];
  audio.pause();
  audio.src = 'samples/' + edition + '.mp3';
  audio.setAttribute('aria-label', selected.name + ' edition of The Maltese Falcon sample');
  document.querySelector('#edition-title').textContent = selected.name + ' edition';
  document.querySelector('#duration').textContent = selected.duration;
  document.querySelector('#voice-note').textContent = selected.note;
  const download = document.querySelector('#download');
  download.href = audio.src;
  download.download = 'storyteller-' + edition + '.mp3';
  for (const button of document.querySelectorAll('[data-edition]')) button.setAttribute('aria-pressed', String(button.dataset.edition === edition));
  timeline = []; active = -1; passageRoot.replaceChildren();
  status.textContent = 'Loading the scene…';
  try {
    if (!cache.has(edition)) cache.set(edition, fetch('samples/' + edition + '.json').then(response => {
      if (!response.ok) throw new Error('Transcript unavailable');
      return response.json();
    }).catch(error => {cache.delete(edition); throw error;}));
    const data = await cache.get(edition);
    if (current !== revision) return;
    timeline = data.assembly.timeline;
    for (const passage of timeline) {
      const text = passage.spans.map(span => data.source.text.slice(span.start, span.end)).join('');
      // Paragraph separators retain source formatting without becoming empty focus stops.
      if (!text.trim()) { const span = document.createElement('span'); span.textContent = text; passageRoot.append(span); continue; }
      const button = document.createElement('span');
      button.setAttribute('role', 'button'); button.tabIndex = 0; button.className = 'passage'; button.textContent = text;
      button.title = 'Seek to this passage';
      const seek = () => {audio.currentTime = passage.start; highlight();};
      button.addEventListener('click', seek);
      button.addEventListener('keydown', event => {if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); seek();}});
      passageRoot.append(button);
    }
    status.textContent = '';
    highlight();
  } catch {
    if (current !== revision) return;
    status.textContent = 'The read-along text could not load. You can still play or download the recording.';
  }
}
for (const button of document.querySelectorAll('[data-edition]')) button.addEventListener('click', () => choose(button.dataset.edition));
audio.addEventListener('timeupdate', highlight);
audio.addEventListener('error', () => {status.textContent = 'Playback could not start. Try the Download MP3 link.';});
const requested = new URLSearchParams(location.search).get('edition');
choose(Object.hasOwn(editions, requested) ? requested : 'breeze');
const copy = document.querySelector('#copy-setup');
copy.hidden = false;
copy.addEventListener('click', async () => {
  const status = document.querySelector('#copy-status');
  try {
    await navigator.clipboard.writeText(document.querySelector('#setup-commands').textContent);
    status.textContent = 'Setup commands copied.';
  } catch { status.textContent = 'Select and copy the commands above.'; }
});
