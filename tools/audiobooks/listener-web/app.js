const editionNames = { v3: 'v3', flash: 'Flash', qwen: 'Qwen local', chatterbox: 'Chatterbox local' };
const $ = id => document.getElementById(id), audio = $('audio');
const say = text => { $('message').textContent = text; $('message').dataset.routine = String(text === 'Ready to listen.'); };
const unreadAudio = count => `${count} unread audio ${count === 1 ? 'chapter' : 'chapters'}`;
const time = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
let library, playing, reading, issueDraft, storageKey, local, historyBefore, catalog, selectedStoryId;
const storyEditions = new Map();
let lastSaved = 0, switching = false, flushing = false, stableSeconds = 0, seekOrigin, programmedSeek = false, follow = true, activePassage = -1, loadVersion = 0;
let includeAuthorNotes = localStorage.getItem('listener:include-author-notes') !== 'false', loadAutoplay = false, chapterEndHandled = false;
let noteTimer, noteOutputGuard;
function updateNoteOutput() { noteOutputGuard?.update(reading, !includeAuthorNotes, switching || readingPending); }
function prepareNoteOutput() {
  if (includeAuthorNotes && !noteOutputGuard) return;
  noteOutputGuard ||= new NoteOutputGuard(audio);
  updateNoteOutput();
  noteOutputGuard.resume().then(updateNoteOutput).catch(() => { audio.pause(); say('Tap Play to continue listening.'); });
}
for (const event of ['pointerdown', 'keydown']) document.addEventListener(event, () => { if (noteOutputGuard?.context.state === 'suspended') noteOutputGuard.resume().then(updateNoteOutput).catch(() => {}); });
let readingPending = false, readingRequest, releasePlayback;
const locationOf = (seconds = audio.currentTime) => playing && ({ story: playing.book.id, edition: playing.edition, assembly: playing.chapter.assembly, seconds });
async function api(path, data, signal) {
  const response = await fetch('/listen' + path, { method: data ? 'POST' : 'GET', headers: data ? { 'Content-Type': 'application/json', ...(library?.accountKey ? { 'X-Listener-Account': library.accountKey } : {}) } : {}, body: data ? JSON.stringify(data) : undefined, signal });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Sync failed.');
  return value;
}
function el(tag, text, parent) { const e = document.createElement(tag); if (text) e.textContent = text; parent?.append(e); return e; }
function button(text, parent, action) { const e = el('button', text, parent); e.onclick = () => Promise.resolve(action()).catch(error => say(error.message)); return e; }
function persist() { localStorage.setItem(storageKey, JSON.stringify(local)); }
function view(name, push = true) {
  if (name === 'library' && library) renderLibrary();
  for (const v of ['library', 'story', 'reading', 'tools', 'history', 'issues']) $(`${v}-view`).hidden = v !== name;
  for (const v of ['library', 'reading', 'tools']) $(`show-${v}`).setAttribute('aria-pressed', String(v === name || (v === 'library' && name === 'story') || (v === 'tools' && ['history', 'issues'].includes(name))));
  const hash = name === 'story' ? `#story/${encodeURIComponent(selectedStoryId)}` : `#${name}`;
  if (push && location.hash !== hash) history.pushState(null, '', hash);
  if (name === 'history') loadHistory().catch(error => say(error.message));
  if (name === 'story') renderStory();
  renderMiniPlayer();
  const heading = $(`${name}-view`).querySelector('h1');
  if (push && heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
}
function route() {
  const hash = location.hash.slice(1);
  if (hash.startsWith('story/')) { selectedStoryId = decodeURIComponent(hash.slice(6)); view('story', false); }
  else view(['reading', 'tools', 'history', 'issues'].includes(hash) ? hash : 'library', false);
}
window.addEventListener('popstate', route);
for (const name of ['library', 'reading', 'tools', 'history', 'issues']) $(`show-${name}`).onclick = () => view(name);
$('back-library').onclick = () => view('library');
$('back-story').onclick = () => { if (playing) openStory(playing.book.id); else view('library'); };
$('history-back').onclick = $('issues-back').onclick = () => view('tools');
$('open-history').onclick = () => view('history');
$('mini-open').onclick = () => view('reading');
$('mini-toggle').onclick = () => audio.paused ? audio.play().catch(error => say(error.message)) : audio.pause();
function renderMiniPlayer() {
  $('mini-player').hidden = !playing || !$('reading-view').hidden;
  if (!playing) return;
  $('mini-title').textContent = playing.book.title;
  $('mini-position').textContent = `${playing.chapter.title} · ${time(audio.currentTime)} / ${time(playing.chapter.duration)}`;
  $('mini-toggle').textContent = audio.paused ? 'Play' : 'Pause';
}
function openStory(id) { selectedStoryId = id; view('story'); }
function summary(book) {
  const positions = Object.values(local.positions).filter(p => p.story === book.id).sort((a, b) => b.deviceTime - a.deviceTime);
  const latest = positions.find(p => book.editions[p.edition]?.chapters.some(c => c.assembly === p.assembly));
  const edition = latest?.edition || book.defaultEdition || Object.keys(book.editions)[0];
  const chapters = book.editions[edition]?.chapters || [];
  const unread = chapters.filter(c => !library.state.completed[`${book.id}:${c.id}`]);
  const remaining = unread.reduce((total, c) => { const p = local.positions[`${book.id}:${edition}:${c.id}`]; return total + c.duration - (p?.assembly === c.assembly ? Math.min(c.duration, Math.max(0, p.seconds)) : 0); }, 0);
  return { latest, edition, chapters, unread, remaining };
}
function renderStory() {
  const repairExpanded = $('story-detail').querySelector('.repair-status details')?.open && $('story-detail').dataset.story === selectedStoryId;
  $('story-detail').dataset.story = selectedStoryId;
  $('story-detail').replaceChildren(); $('story-management').replaceChildren();
  const book = library?.books.find(b => b.id === selectedStoryId);
  const source = catalog?.stories.find(b => b.id === selectedStoryId);
  el('h1', book?.title || source?.title || 'Story unavailable', $('story-detail'));
  el('p', book?.author || source?.author, $('story-detail'));
  if (source?.repair) renderRepair(source.repair, $('story-detail'), repairExpanded);
  if (book) {
    const info = summary(book);
    el('p', `${unreadAudio(info.unread.length)} · ${time(info.remaining)} remaining`, $('story-detail'));
    if (info.latest) button('Continue listening', $('story-detail'), () => openLocation(info.latest, true));
    else if (info.chapters.length) button('Start listening', $('story-detail'), () => play(book, info.edition, info.chapters[0], 0, true, 'chapter'));
    el('h2', 'Chapters', $('story-detail'));
    const editions = el('div', null, $('story-detail')); editions.className = 'editions'; const list = el('div', null, $('story-detail'));
    function show(edition) {
      storyEditions.set(book.id, edition);
      list.replaceChildren(); for (const b of editions.children) b.setAttribute('aria-pressed', String(b.dataset.edition === edition));
      for (const chapter of book.editions[edition]?.chapters || []) {
        const row = el('div', null, list); row.className = 'chapter'; const text = el('div', null, row); el('strong', chapter.title, text);
        const previous = local.positions[`${book.id}:${edition}:${chapter.id}`];
        el('small', `${time(chapter.duration)}${previous?.assembly === chapter.assembly ? ` · Saved at ${time(previous.seconds)}` : ''}${library.state.completed[`${book.id}:${chapter.id}`] ? ' · Finished' : ''}`, text);
        if (edition === 'qwen') { const repair = source?.repair?.chapters.find(c => c.id === chapter.id); if (repair) el('small', repair.label, text).className = 'repair-label'; }
        button('Listen', row, () => play(book, edition, chapter, previous?.assembly === chapter.assembly ? previous.seconds : 0, true, 'chapter'));
      }
      if (!list.children.length) el('p', 'This edition is not ready yet.', list);
    }
    for (const edition of Object.keys(book.editions)) { const b = button(editionNames[edition] || edition, editions, () => show(edition)); b.dataset.edition = edition; }
    show(storyEditions.get(book.id) || info.edition);
  } else el('p', source ? 'Audio is not ready yet. Check chapter availability and preparation below.' : 'Sync your library to check whether this story is still available.', $('story-detail'));
  if (source) renderSourceStory(source, $('story-management'));
}
async function flush() {
  if (flushing || !local) return;
  flushing = true;
  try {
    while (local.pending.length) { const event = local.pending[0]; await api('/progress', event); local.pending.shift(); persist(); }
    if (/^\d+ locations saved on this device/.test($('message').textContent)) say('Your listening positions are synced.');
  } catch { say(`${local.pending.length} locations saved on this device. Sync will retry when connected.`); }
  finally { flushing = false; }
}
function save(reason = 'pause', from, completed = false) {
  if (!playing || switching || !local) return;
  const progress = { ...locationOf(), eventId: crypto.randomUUID(), deviceTime: Date.now(), reason, completed, ...(from ? { from } : {}) };
  local.pending.push(progress);
  const key = `${playing.book.id}:${playing.edition}:${playing.chapter.id}`;
  local.positions[key] = progress; local.selected = progress;
  if (from && ['seek', 'passage', 'chapter'].includes(reason)) local.undo = from;
  persist(); lastSaved = Date.now(); $('undo').hidden = !local.undo;
  if (completed) library.state.completed[`${playing.book.id}:${playing.chapter.id}`] = true;
  flush();
}
function renderLibrary() {
  $('library').replaceChildren(); $('continue').replaceChildren();
  const stories = new Map(library.books.map(book => [book.id, book]));
  for (const story of catalog?.stories || []) if (!stories.has(story.id)) stories.set(story.id, story);
  for (const book of stories.values()) {
    const row = el('article', null, $('library')); row.className = 'story-row';
    const source = catalog?.stories.find(s => s.id === book.id);
    if (source?.hasCover) { const img = el('img', null, row); img.src = `/listen/stories/${book.id}/cover`; img.alt = ''; img.loading = 'lazy'; }
    const content = el('div', null, row); const heading = el('h2', null, content);
    const link = el('a', book.title, heading); link.href = `#story/${encodeURIComponent(book.id)}`;
    link.onclick = event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); openStory(book.id); } };
    el('p', book.author, content);
    if (source?.repair) el('p', `${source.repair.title}${source.repair.total ? ` · ${source.repair.completed} of ${source.repair.total} updated` : ''}`, content).className = 'repair-label';
    if (book.editions) {
      const info = summary(book); const chapter = info.latest && findLocation(info.latest)?.chapter;
      el('p', chapter ? `Your place: Chapter ${chapter.sequence} · ${time(info.latest.seconds)}` : 'Not started', content).className = 'story-position';
      el('p', `${unreadAudio(info.unread.length)} · ${time(info.remaining)} remaining`, content).className = 'story-unread';
    } else el('p', `${book.chapters?.length || 0} source chapters · Audio not ready yet`, content).className = 'story-position';
  }
  if (!stories.size) { el('h2', 'Your library is waiting', $('library')); el('p', 'Follow a story in Tools, or tag a book Audiobook: Auto in BookOrbit.', $('library')); button('Open tools', $('library'), () => view('tools')); }
  $('issues').replaceChildren();
  for (const issue of library.state.issues.slice().reverse()) {
    const row = el('div', null, $('issues')); row.className = 'issue'; el('strong', `Chapter ${issue.sequence} · ${issue.edition} · ${time(issue.seconds)} · ${issue.kind}`, row); el('p', issue.note || 'No note', row);
    button(issue.status === 'open' ? 'Mark resolved' : 'Reopen', row, async () => { await api('/issues/resolve', { id: issue.id, resolved: issue.status === 'open' }); await refresh(); });
  }
  if (!library.state.issues.length) el('p', 'No issues marked yet.', $('issues'));
}
async function refresh() {
  await flush(); const next = await api('/library');
  if (library && next.accountKey !== library.accountKey) { audio.pause(); location.reload(); return; }
  library = next; storageKey = `listener:${library.accountKey}`;
  if (!local) { try { local = JSON.parse(localStorage.getItem(storageKey)); } catch {} local ||= { positions: {}, pending: [] }; }
  for (const [key, value] of Object.entries(library.state.positions)) if (!local.positions[key] || value.deviceTime > local.positions[key].deviceTime) local.positions[key] = value;
  persist(); renderLibrary();
  say(library.books.length ? 'Ready to listen.' : 'Your chapters will appear here when generation finishes.');
  await flush();
  await refreshCatalog();
}
function setFollow(value) { follow = value; $('follow').textContent = follow ? 'Following audio' : 'Follow audio'; $('follow').setAttribute('aria-pressed', String(follow)); if (follow) highlight(true); }
function highlight(force = false) {
  if (!reading) return;
  let index = 0; for (let i = 0; i < reading.passages.length; i++) { if (reading.passages[i].start <= audio.currentTime) index = i; else break; }
  if (index === activePassage && !force) return;
  $('passages').children[activePassage]?.removeAttribute('aria-current'); activePassage = index;
  const current = $('passages').children[index]; current?.setAttribute('aria-current', 'true');
  $('passage-label').textContent = `Passage ${index + 1} of ${reading.passages.length} · ${time(audio.currentTime)}`;
  if (follow && current) {
    const page = $('passages'), rect = current.getBoundingClientRect(), viewport = page.getBoundingClientRect();
    if (rect.top < viewport.top || rect.bottom > viewport.bottom) page.scrollTo({ top: page.scrollTop + rect.top - viewport.top - 12, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
}
function seek(seconds, reason = 'seek') {
  if (!playing || switching) return;
  const from = locationOf(), autoplay = !audio.paused, target = notePosition(seconds); if (target < playing.chapter.duration - .100001) chapterEndHandled = false; programmedSeek = true; audio.currentTime = target; stableSeconds = audio.currentTime;
  save(reason, from); highlight(true);
  if (!includeAuthorNotes && audio.currentTime >= playing.chapter.duration) finishChapter(autoplay);
}
function notePosition(seconds) {
  let target = Math.max(0, Math.min(playing.chapter.duration, seconds));
  if (includeAuthorNotes || !reading) return target;
  for (let i = 0; i < reading.passages.length; i++) {
    const p = reading.passages[i];
    if (p.sectionKind !== 'author-note' || !Number.isFinite(p.start) || !Number.isFinite(p.end) || p.start < 0 || p.end <= p.start || p.end > playing.chapter.duration + .1) continue;
    if (target >= p.start && target < p.end) {
      target = Math.min(p.end, playing.chapter.duration);
      if (i === reading.passages.length - 1 && playing.chapter.duration - target <= .100001) target = playing.chapter.duration;
    }
  }
  return target;
}
function skipNotes(autoplay = !audio.paused) {
  if (!playing || switching || audio.seeking) return false;
  const target = notePosition(audio.currentTime);
  if (target === audio.currentTime) return false;
  programmedSeek = true; audio.currentTime = target; stableSeconds = target;
  if (target >= playing.chapter.duration) finishChapter(autoplay);
  else { save('playing'); highlight(true); }
  return true;
}
function scheduleNotes() {
  updateNoteOutput();
  clearTimeout(noteTimer);
  if (includeAuthorNotes || !reading || switching || audio.paused || audio.seeking) return;
  const next = reading.passages.find(p => p.sectionKind === 'author-note' && Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start && p.start > audio.currentTime && p.end <= playing.chapter.duration + .1);
  if (next) noteTimer = setTimeout(() => { skipNotes(); scheduleNotes(); }, Math.max(5, Math.min(2147483647, (next.start - audio.currentTime) * 1000 / audio.playbackRate)));
}
function finishChapter(autoplay = true) {
  if (!playing || switching || chapterEndHandled) return;
  chapterEndHandled = true; save('complete', undefined, true);
  const chapters = playing.book.editions[playing.edition].chapters;
  const next = chapters[chapters.findIndex(c => c.assembly === playing.chapter.assembly) + 1];
  if (next) play(playing.book, playing.edition, next, 0, autoplay, 'chapter').catch(error => say(error.message));
  else { audio.pause(); renderLibrary(); }
}
async function play(book, edition, chapter, seconds = 0, autoplay = false, reason = 'restore', reveal = true) {
  prepareNoteOutput();
  const from = locationOf(); save('pause'); switching = true; audio.pause(); const version = ++loadVersion;
  clearTimeout(noteTimer);
  readingRequest?.abort(); const request = new AbortController(); readingRequest = request; readingPending = true;
  const textTimeout = setTimeout(() => request.abort(), 10000);
  playing = { book, edition, chapter }; reading = undefined; activePassage = -1; chapterEndHandled = false; loadAutoplay = autoplay;
  updateNoteOutput();
  $('player').hidden = false; $('reader-empty').hidden = true; $('book-title').textContent = book.title; $('chapter-title').textContent = chapter.title;
  $('edition-label').textContent = `${editionNames[edition] || edition} edition`; $('passages').replaceChildren(); $('reader-status').textContent = 'Loading the generated passages…'; $('source-link').hidden = true;
  if (reveal) view('reading'); renderMiniPlayer(); setFollow(true); $('undo').hidden = !local.undo;
  let metadataReady = false, textReady = false, started = false;
  const ready = () => {
    if (version !== loadVersion || !metadataReady || (!includeAuthorNotes && !textReady)) return;
    if (!started) {
      started = true;
      programmedSeek = true; audio.currentTime = notePosition(seconds); stableSeconds = audio.currentTime;
      audio.playbackRate = Number($('speed').value); switching = false; save(reason, reason === 'chapter' ? from : undefined); highlight(true);
    } else if (!includeAuthorNotes) { skipNotes(loadAutoplay); if (version !== loadVersion || chapterEndHandled) return; }
    const requested = loadAutoplay; loadAutoplay = false;
    if (!includeAuthorNotes && audio.currentTime >= chapter.duration) finishChapter(requested);
    else if (requested) audio.play().catch(error => { if (version === loadVersion && error.name !== 'AbortError') say(error.message); });
  };
  releasePlayback = ready;
  audio.onloadedmetadata = () => { metadataReady = true; ready(); };
  audio.src = `/listen/stories/${book.id}/${edition}/audio/${chapter.assembly}`;
  try {
    const text = await api(`/stories/${book.id}/${edition}/text/${chapter.assembly}`, undefined, request.signal); if (version !== loadVersion) return; reading = text;
    for (const passage of text.passages) {
      const p = el('span', passage.text, $('passages')); p.className = 'passage'; p.dataset.start = passage.start; p.setAttribute('role', 'button'); p.tabIndex = 0;
      p.onclick = () => { if (!getSelection()?.toString()) seek(passage.start, 'passage'); };
      p.onkeydown = event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); seek(passage.start, 'passage'); } };
    }
    $('reader-status').textContent = '';
    if (/^https:\/\/(www\.royalroad\.com|books\.example\.org)\//.test(text.url)) { $('source-link').href = text.url; $('source-link').hidden = false; }
    highlight(true);
  } catch (error) { if (version === loadVersion) $('reader-status').textContent = includeAuthorNotes ? `Text could not load: ${error.message}` : 'Author-note timings are unavailable. Playing the full chapter.'; }
  finally { clearTimeout(textTimeout); textReady = true; if (version === loadVersion) { readingPending = false; readingRequest = undefined; } ready(); }
}
function findLocation(value) {
  const book = library.books.find(b => b.id === value.story); if (!book) return;
  const chapter = book.editions[value.edition]?.chapters.find(c => c.assembly === value.assembly); return chapter && { book, chapter };
}
async function openLocation(value, autoplay = false, reason = 'restore', reveal = true) {
  let found = findLocation(value);
  if (!found) {
    const book = library.books.find(b => b.id === value.story); if (!book) throw new Error('This story is no longer in the library.');
    const text = await api(`/stories/${value.story}/${value.edition}/text/${value.assembly}`);
    found = { book, chapter: { id: text.chapterId, title: text.title, duration: text.duration, assembly: value.assembly } };
  }
  await play(found.book, value.edition, found.chapter, value.seconds, autoplay, reason, reveal);
}
async function loadHistory(earlier = false) {
  if (!earlier) $('history').replaceChildren();
  const result = await api('/history' + (earlier && historyBefore ? `?before=${historyBefore}` : ''));
  for (const event of result.entries) {
    const row = el('article', null, $('history')); row.className = 'history-entry'; const l = event.location;
    el('h2', `${l.chapterTitle} · ${time(l.seconds)}`, row);
    el('p', `${new Date(event.deviceTime).toLocaleString()} · ${event.reason} · ${editionNames[l.edition] || l.edition} · Passage ${l.passageIndex + 1}`, row);
    el('p', `${time(l.storySeconds)} into ${time(l.storyDuration)} of generated audio (${l.chapterCount} chapters)`, row);
    el('blockquote', l.excerpt, row); button('Return here', row, () => openLocation(l, false, 'chapter'));
    if (event.from) { el('p', `Moved from ${event.from.chapterTitle} · ${time(event.from.seconds)} · Passage ${event.from.passageIndex + 1}`, row); button('Before this jump', row, () => openLocation(event.from, false, 'chapter')); }
  }
  if (!$('history').children.length) el('p', 'Your saved listening locations will appear here.', $('history'));
  historyBefore = result.before; $('more-history').hidden = !historyBefore;
}
$('more-history').onclick = () => loadHistory(true).catch(error => say(error.message));
$('undo').onclick = () => { const target = local.undo; if (target) openLocation(target, !audio.paused, 'chapter').catch(error => say(error.message)); };
$('follow').onclick = () => setFollow(!follow);
for (const event of ['wheel', 'touchstart', 'pointerdown']) $('passages').addEventListener(event, () => setFollow(false), { passive: true });
$('passages').addEventListener('keydown', event => { if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) setFollow(false); });
$('text-size').value = localStorage.getItem('listener:book-text-size') || '14';
function textSize() { $('passages').style.setProperty('--reader-size', `${$('text-size').value}px`); localStorage.setItem('listener:book-text-size', $('text-size').value); }
$('text-size').onchange = textSize; textSize();
$('speed').value = localStorage.getItem('listener:speed') || '1';
$('speed').onchange = () => { audio.playbackRate = Number($('speed').value); localStorage.setItem('listener:speed', $('speed').value); };
$('include-author-notes').checked = includeAuthorNotes;
$('include-author-notes').onchange = () => { includeAuthorNotes = $('include-author-notes').checked; localStorage.setItem('listener:include-author-notes', String(includeAuthorNotes)); prepareNoteOutput(); if (!includeAuthorNotes && readingPending) { if (!switching) loadAutoplay = !audio.paused; audio.pause(); } else { releasePlayback?.(); skipNotes(); } scheduleNotes(); };
$('back').onclick = () => seek(audio.currentTime - 15); $('forward').onclick = () => seek(audio.currentTime + 30);
function adjacent(delta) { if (!playing) return; const chapters = playing.book.editions[playing.edition].chapters; const chapter = chapters[chapters.findIndex(c => c.assembly === playing.chapter.assembly) + delta]; if (chapter) return play(playing.book, playing.edition, chapter, 0, !audio.paused, 'chapter'); }
$('previous-chapter').onclick = () => adjacent(-1); $('next-chapter').onclick = () => adjacent(1);
audio.ontimeupdate = () => { if (skipNotes()) return; scheduleNotes(); renderMiniPlayer(); highlight(); if (!switching && !audio.seeking) { stableSeconds = audio.currentTime; if (!audio.paused && Date.now() - lastSaved > 5000) save('playing'); } };
audio.onseeking = () => { updateNoteOutput(); if (!switching && !programmedSeek) { if (notePosition(audio.currentTime) < playing.chapter.duration - .100001) chapterEndHandled = false; if (!seekOrigin) seekOrigin = locationOf(stableSeconds); } };
audio.onseeked = () => { const from = seekOrigin, assembly = playing?.chapter.assembly; seekOrigin = undefined; if (skipNotes()) { if (from && playing?.chapter.assembly === assembly) save('seek', from); return; } if (programmedSeek) programmedSeek = false; else if (from) save('seek', from); stableSeconds = audio.currentTime; highlight(true); scheduleNotes(); };
audio.onpause = () => { updateNoteOutput(); clearTimeout(noteTimer); save('pause'); renderMiniPlayer(); };
audio.onplay = () => { prepareNoteOutput(); if (switching || (!includeAuthorNotes && readingPending)) { loadAutoplay = true; audio.pause(); return; } skipNotes(true); scheduleNotes(); renderMiniPlayer(); };
audio.onratechange = scheduleNotes;
audio.onended = () => finishChapter();
audio.onerror = () => { switching = false; say('Audio could not load. Check your connection and sign in again if needed.'); };
$('complete').onclick = () => { save('complete', undefined, true); renderLibrary(); };
$('refresh').onclick = () => refresh().catch(error => say(error.message));
window.addEventListener('online', flush); document.addEventListener('visibilitychange', () => { if (document.hidden) save('pause'); }); window.addEventListener('pagehide', () => save('pause'));
$('mark-issue').onclick = () => { if (!playing) return; issueDraft = { ...locationOf(), eventId: crypto.randomUUID() }; audio.pause(); $('issue-time').textContent = `Issue at ${time(issueDraft.seconds)}`; $('issue-dialog').showModal(); $('note').focus(); };
$('cancel-issue').onclick = () => { issueDraft = undefined; $('issue-dialog').close(); };
$('issue').onsubmit = async event => { event.preventDefault(); if (!issueDraft) return; try { await api('/issues', { ...issueDraft, kind: $('kind').value, note: $('note').value }); issueDraft = undefined; $('issue-dialog').close(); $('note').value = ''; await refresh(); say('Issue saved.'); } catch (error) { say(error.message); } };
const code = new URLSearchParams(location.search).get('code');
if (location.pathname === '/listen/pair' && /^[A-F0-9]{10}$/.test(code ?? '')) { $('pair').hidden = false; $('code').textContent = code; $('approve').onclick = async () => { try { await api('/pair/approve', { code }); $('approve').disabled = true; say('Connected. Return to your Android listener.'); } catch (error) { say(error.message); } }; }
refresh().then(() => { const latest = Object.values(local.positions).sort((a, b) => b.deviceTime - a.deviceTime)[0]; if (latest && !code) return openLocation(latest, false, 'restore', false); }).then(route).catch(error => say(error.message));


async function refreshCatalog() {
  try {
    catalog = await api('/catalog');
    $('queue').replaceChildren();
    for (const job of catalog.jobs.filter(j => j.status !== 'complete').slice(0, 12)) {
      const row = el('article', null, $('queue')); row.className = 'queue-job';
      el('strong', `${job.story} · ${job.status}`, row); el('p', job.phase, row); if (job.error) el('p', job.error, row);
      if (['queued', 'running', 'waiting'].includes(job.status)) button(job.cancel ? 'Cancelling after this passage…' : 'Cancel job', row, async () => { await api('/jobs', { id: job.id, action: 'cancel' }); await refreshCatalog(); });
      if (['failed', 'cancelled', 'waiting'].includes(job.status)) button('Retry now', row, async () => { await api('/jobs', { id: job.id, action: 'retry' }); await refreshCatalog(); });
    }
    renderLibrary(); if (!$('story-view').hidden) renderStory();
    $('catalog-status').textContent = catalog.stories.length ? '' : 'Paste a Royal Road story URL to add it to your library.';
  } catch (error) { $('catalog-status').textContent = `Library check failed: ${error.message}`; }
}
function renderSourceStory(story, parent) {
      const card = el('article', null, parent); card.className = 'archive-book'; const heading = el('div', null, card); heading.className = 'archive-heading';
      if (story.hasCover) { const img = el('img', null, heading); img.src = `/listen/stories/${story.id}/cover`; img.alt = ''; img.loading = 'lazy'; }
      const title = el('div', null, heading); el('h2', 'Story preparation', title); el('p', story.author, title);
      el('p', `${story.chapters.filter(c => c.downloaded).length} downloaded · ${story.chapters.filter(c => c.editions.includes('qwen')).length} with Qwen audio · ${story.status.toLowerCase()}`, title);
      const fromBookOrbit = story.id.startsWith('bo-');
      const link = el('a', fromBookOrbit ? 'Open source book' : 'Open on Royal Road', title); link.href = fromBookOrbit ? story.url : story.url;
      const description = el('details', null, card); el('summary', 'About this story', description); el('p', story.description, description);
      if (story.supported === false) return;
      const controls = el('div', null, card); controls.className = 'controls'; const label = el('label', 'Prepare ', controls); const mode = el('select', null, label);
      for (const [value, text] of [['buffer', 'Next 5 unread chapters'], ['all', 'Every available chapter'], ['download', 'Download text only']]) { const option = el('option', text, mode); option.value = value; }
      mode.value = story.follow?.mode || 'buffer';
      const update = async enabled => { await api('/follow', { url: story.url, enabled, mode: mode.value, buffer: 5, intervalHours: 6 }); await refreshCatalog(); };
      button(story.follow?.enabled ? 'Pause automatic checks' : 'Follow story', controls, () => update(!story.follow?.enabled));
      if (story.follow) button('Check now', controls, async () => { await api('/check', { story: story.id }); await refreshCatalog(); });
      mode.onchange = () => update(story.follow?.enabled ?? false).catch(error => say(error.message));
      el('p', story.follow?.enabled ? `Checks every ${story.follow.intervalHours} hours. Qwen audio uses the saved story cast.` : 'Automatic checks are paused.', card);
      const chapters = el('details', null, card); el('summary', `${story.chapters.length} chapters`, chapters);
      for (const chapter of story.chapters) { const row = el('div', null, chapters); row.className = 'chapter'; const text = el('div', null, row); el('strong', chapter.title, text); el('small', chapter.editions.length ? `Audio: ${chapter.editions.map(e => editionNames[e] || e).join(', ')}` : chapter.downloaded ? 'Text downloaded · audio not generated' : chapter.availability === 'locked' ? 'Locked on Royal Road' : 'Not downloaded', text); if (chapter.downloaded) { const a = el('a', 'Read', row); a.href = `/#${story.id}/${chapter.chapterId}`; } }
    }

$('follow-story').onsubmit = async event => {
  event.preventDefault();
  try { await api('/follow', { url: $('story-url').value, enabled: true, mode: $('new-mode').value, buffer: 5, intervalHours: 6 }); $('story-url').value = ''; await refreshCatalog(); say('Story queued. Its chapters will appear after the first check.'); }
  catch (error) { say(error.message); }
};
setInterval(() => { if (library && !document.hidden) refreshCatalog(); }, 30000);

function renderRepair(repair, parent, expanded = false) {
  const panel = el('section', null, parent); panel.className = 'repair-status';
  el('h2', repair.title, panel);
  el('p', repair.detail, panel);
  if (repair.total) {
    const label = `${repair.completed} of ${repair.total} chapters updated`;
    el('p', label, panel);
    const progress = el('progress', null, panel); progress.max = repair.total; progress.value = repair.completed; progress.setAttribute('aria-label', label);
    const details = el('details', null, panel); details.open = expanded; el('summary', 'Chapter repair queue', details);
    for (const chapter of repair.chapters) { const row = el('div', null, details); row.className = 'chapter'; const text = el('div', null, row); el('strong', chapter.title, text); el('small', chapter.label, text); }
  }
  if (repair.updatedAt) el('small', `Last activity: ${new Date(repair.updatedAt).toLocaleString()}`, panel);
}
