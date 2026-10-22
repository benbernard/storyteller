const editionNames = { v3: 'v3', flash: 'Flash', qwen: 'Qwen local', chatterbox: 'Chatterbox local' };
function icon(element, name, label) { element.innerHTML = listenerIcons[name]; if (label) element.setAttribute('aria-label', label); }
const $ = id => document.getElementById(id), audio = $('audio');
const say = text => { $('message').textContent = text; $('message').dataset.routine = String(text === 'Ready to listen.'); };
const unreadAudio = count => `${count} unread audio ${count === 1 ? 'chapter' : 'chapters'}`;
const time = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
let library, playing, reading, issueDraft, storageKey, local, historyBefore, catalog, selectedStoryId;
let routingDialog = false;
let page = 'library', libraryFilter = 'All', issueFilter = 'All', browsed, browseReading, browseVersion = 0, returnGeneration = 0, capabilities = {}, connected = navigator.onLine;
const scrollPositions = new Map();
for (const [id, name] of Object.entries({ 'nav-back': 'arrow_back', settings: 'settings', refresh: 'refresh', account: 'more_vert', undo: 'undo', back: 'replay', forward: 'forward_30', toggle: 'play_arrow', 'mark-issue': 'flag', 'audio-output': 'speaker', 'open-history': 'history', 'browse-chapters': 'headset', 'mini-toggle': 'play_arrow' })) icon($(id), name);
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', event => { const r = dialog.getBoundingClientRect(); if (event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)) dialog.close(); });
  dialog.addEventListener('close', () => { if (!routingDialog && history.state?.sheet === dialog.id) history.back(); });
  dialog.querySelectorAll('[data-close]').forEach(button => button.onclick = () => dialog.close());
}
function openDialog(dialog) { history.pushState({ ...history.state, listener: true, sheet: dialog.id, depth: (history.state?.depth || 0) + 1 }, '', location.href); dialog.showModal(); }
$('history-dialog').addEventListener('close', () => { returnGeneration++; });
let lastSaved = 0, switching = false, flushing = false, stableSeconds = 0, seekOrigin, programmedSeek = false, follow = true, activePassage = -1, loadVersion = 0;
let includeAuthorNotes = localStorage.getItem('listener:include-author-notes') !== 'false', loadAutoplay = false, chapterEndHandled = false;
let noteTimer, noteOutputGuard, visiblePassages = [], seekDraft, playRequest = 0;
function chapterView(chapter = playing?.chapter) {
  const ranges = chapter && reading?.assembly === chapter.assembly ? ChapterView.ranges(reading, chapter.duration) : chapter?.authorNoteRanges || [];
  return new ChapterView(chapter?.duration || 0, includeAuthorNotes ? [] : ranges);
}
function renderPlayback() {
  const view = chapterView(), position = seekDraft ?? view.position(audio.currentTime);
  for (const id of ['back','forward','mark-issue','open-history','follow']) $(id).disabled = !playing;
  $('chapter-position').max = String(view.duration || 1);
  $('chapter-position').disabled = !playing || switching || view.duration <= 0;
  $('chapter-position').value = String(position);
  $('chapter-position').setAttribute('aria-valuetext', `${time(position)} of ${time(view.duration)}`);
  $('elapsed').textContent = time(position); $('remaining').textContent = `−${time(Math.max(0, view.duration - position))}`;
  icon($('toggle'), audio.paused ? 'play_arrow' : 'pause', audio.paused ? 'Play' : 'Pause');
  if (navigator.mediaSession?.setPositionState && view.duration > 0) navigator.mediaSession.setPositionState({ duration: view.duration, position: Math.min(position, view.duration), playbackRate: audio.playbackRate });
}
function renderPassages() {
  $('passages').replaceChildren(); activePassage = -1;
  visiblePassages = []; let omitted = false;
  for (const passage of (browsed ? browseReading : reading)?.passages || []) {
    if (!includeAuthorNotes && passage.sectionKind === 'author-note') { omitted = true; continue; }
    if (omitted && visiblePassages.length) $('passages').append(document.createTextNode('\n\n'));
    omitted = false; visiblePassages.push(passage);
    const p = el('span', passage.text, $('passages')); p.className = 'passage'; p.dataset.start = passage.start; p.setAttribute('role', 'button'); p.tabIndex = 0;
    p.onclick = () => { if (!getSelection()?.toString()) passageSeek(passage.start).catch(error => say(error.message)); };
    p.onkeydown = event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); passageSeek(passage.start).catch(error => say(error.message)); } };
  }
  highlight(true);
}
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
function richLocation(seconds = audio.currentTime) {
  if (!playing) return;
  const passage = reading?.passages.findLast(p => p.start <= seconds);
  return { ...locationOf(seconds), chapterTitle: playing.chapter.title, chapterId: playing.chapter.id, chapter: playing.chapter.sequence, excerpt: passage?.text.slice(0, 200) || '', selection: playing };
}
const undoLocation = () => richLocation(chapterView().undoPosition(audio.currentTime, reading?.passages));
const wireLocation = value => value && ({ story: value.story, edition: value.edition, assembly: value.assembly, seconds: value.seconds });
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
  scrollPositions.set(page + ':' + (['story','chapters','preparation'].includes(page) ? selectedStoryId : ''), document.querySelector('main').scrollTop);
  page = name;
  if (name !== 'reading') browseVersion++;
  if (name === 'library' && library) renderLibrary();
  for (const v of ['library', 'story', 'chapters', 'preparation', 'reading', 'issues', 'account']) $(`${v}-view`).hidden = v !== name;
  $('nav-back').hidden = name === 'library';
  $('settings').hidden = !['reading', 'preparation'].includes(name);
  $('settings').setAttribute('aria-label', name === 'preparation' ? 'Preparation settings' : 'Listening settings');
  $('refresh').hidden = name === 'reading';
  $('page-title').textContent = ({ library: 'Your library', story: 'Book', chapters: 'Chapters', preparation: 'Preparation', issues: 'Marked issues', account: 'Account', reading: playing?.chapter.title || browsed?.chapter.title || 'Listening' })[name];
  $('page-subtitle').textContent = name === 'reading' ? playing?.book.title || browsed?.book.title || '' : '';
  const hash = ['story', 'chapters', 'preparation'].includes(name) ? `#${name}/${encodeURIComponent(selectedStoryId)}` : `#${name}`;
  if (push && location.hash !== hash) history.pushState({listener:true,depth:(history.state?.depth || 0)+1}, '', hash);
  if (name === 'story') renderStory();
  if (name === 'chapters') renderChapters();
  if (name === 'preparation') renderPreparation();
  if (name === 'issues') renderIssues();
  if (name === 'account') { $('account-label').textContent = capabilities.accountLabel || 'Signed in'; $('pending-status').textContent = `${local.pending.length + (local.issueQueue?.length || 0)} changes waiting to sync · ${Object.keys(local.drafts || {}).length} issue drafts kept on this browser`; }
  document.querySelector('main').scrollTop = scrollPositions.get(page + ':' + (['story','chapters','preparation'].includes(page) ? selectedStoryId : '')) || 0;
  renderMiniPlayer();
}
function route() {
  if (!library) return;
  routingDialog = true;
  for (const dialog of document.querySelectorAll('dialog[open]')) if (dialog.id !== history.state?.sheet) dialog.close();
  if (history.state?.sheet) { const dialog = $(history.state.sheet); if (dialog && !dialog.open) dialog.showModal(); routingDialog = false; return; }
  routingDialog = false;
  const [name, story] = location.hash.slice(1).split('/');
  if (['story', 'chapters', 'preparation'].includes(name) && story) selectedStoryId = decodeURIComponent(story);
  view(['reading', 'story', 'chapters', 'preparation', 'issues', 'account'].includes(name) ? name : 'library', false);
}
const initialNavigation = history.state?.sheet ? new Promise(resolve => { window.addEventListener('popstate', resolve, {once:true}); history.back(); }) : Promise.resolve();
if (!history.state?.listener) { const requested = location.hash; history.replaceState({listener:true,depth:0}, '', '#library'); if (requested && requested !== '#library') history.pushState({listener:true,depth:1}, '', requested); }
window.addEventListener('popstate', route);
$('nav-back').onclick = () => { if ((history.state?.depth || 0) > 0) { history.back(); return; } if (page === 'reading') { if (selectedStoryId || playing || browsed) { selectedStoryId ||= playing?.book.id || browsed?.book.id; view('chapters'); } else view('library'); } else if (['chapters', 'preparation', 'issues'].includes(page) && selectedStoryId) view('story'); else view('library'); };
$('account').onclick = () => view('account');
$('sync-account').onclick = () => refresh().catch(error => say(error.message));
$('browse-chapters').onclick = () => { selectedStoryId = playing?.book.id || browsed?.book.id; view('chapters'); };
$('mini-open').onclick = () => { browsed = undefined; renderPassages(); view('reading'); };
$('mini-toggle').onclick = () => audio.paused ? audio.play().catch(error => say(error.message)) : audio.pause();
function renderMiniPlayer() {
  $('mini-player').hidden = !playing || page === 'reading';
  if (!playing) return;
  $('mini-title').textContent = playing.book.title;
  $('mini-position').textContent = `${playing.chapter.title} · ${time(chapterView().position(audio.currentTime))}`;
  icon($('mini-toggle'), audio.paused ? 'play_arrow' : 'pause', audio.paused ? 'Play' : 'Pause');
}
function openStory(id) { selectedStoryId = id; view('story'); }

function summary(book) {
  const positions = Object.values(local.positions).filter(p => p.story === book.id).sort((a, b) => b.deviceTime - a.deviceTime);
  const latest = positions.find(p => book.editions[p.edition]?.chapters.some(c => c.assembly === p.assembly));
  const edition = latest?.edition || book.defaultEdition || Object.keys(book.editions)[0];
  const chapters = book.editions[edition]?.chapters || [];
  const unread = chapters.filter(c => !library.state.completed[`${book.id}:${c.id}`]);
  const remaining = unread.reduce((total, c) => { const p = local.positions[`${book.id}:${edition}:${c.id}`], view = chapterView(c); return total + view.duration - (p?.assembly === c.assembly ? view.position(p.seconds) : 0); }, 0);
  return { latest, edition, chapters, unread, remaining };
}
function renderStory() {
  $('story-detail').replaceChildren(); $('story-management').replaceChildren();
  const book = library?.books.find(b => b.id === selectedStoryId), source = catalog?.stories.find(b => b.id === selectedStoryId), parent = $('story-detail');
  el('h2', book?.title || source?.title || 'Book unavailable', parent); el('p', book?.author || source?.author, parent);
  if (book) {
    const info = summary(book);
    const start = button(info.latest ? 'Continue listening' : 'Play book', parent, () => info.latest ? openLocation(info.latest, true, 'chapter') : play(book, info.edition, info.chapters[0], 0, true, 'chapter'));
    start.disabled = !info.chapters.length; start.className = 'primary';
    el('p', `${unreadAudio(info.unread.length)} · ${time(info.remaining)} left`, parent);
    button('Chapters', parent, () => view('chapters'));
  } else { const unavailable = button('Audio is preparing', parent, () => {}); unavailable.disabled = true; el('p', 'Play will be available when audio is published.', parent); }
  if (source?.description) el('p', source.description, parent);
  button('Marked issues', parent, () => { $('issue-book').value = selectedStoryId; view('issues'); });
  if (source) button('Preparation', parent, () => view('preparation'));
  el('p', 'Offline downloads are available in the Android app.', parent).className = 'fine';
}
function renderChapters() {
  const parent = $('chapters'); parent.replaceChildren();
  const book = library.books.find(b => b.id === selectedStoryId); if (!book) { el('p', 'No published chapters yet.', parent); return; }
  const edition = playing?.book.id === book.id ? playing.edition : summary(book).edition;
  const available = book.editions[edition]?.chapters || [];
  const all = [...new Map(Object.values(book.editions).flatMap(e => e.chapters).map(c => [c.id,c])).values()].sort((a,b)=>a.sequence-b.sequence);
  for (const candidate of all) {
    const chapter = available.find(c=>c.id===candidate.id) || candidate, present = available.some(c=>c.assembly===chapter.assembly);
    const textEdition = present ? edition : Object.keys(book.editions).find(e=>book.editions[e].chapters.some(c=>c.assembly===chapter.assembly));
    if (!chapter.title.toLowerCase().includes($('chapter-search').value.trim().toLowerCase())) continue;
    const row = el('article', null, parent); row.className = 'chapter';
    const browse = button(chapter.title, row, () => browseChapter(book, textEdition, chapter, present)); browse.className = 'chapter-title';
    el('small', present ? time(chapterView(chapter).duration) : 'Audio isn’t ready in this edition', row);
    const start = button('', row, () => { const resume = playing?.book.id === book.id && playing.edition === edition && playing.chapter.assembly === chapter.assembly; return play(book, edition, chapter, resume ? audio.currentTime : 0, true, 'chapter'); }); start.className = 'icon'; start.disabled = !present || !connected; icon(start, 'play_arrow', `${playing?.chapter.assembly === chapter.assembly ? 'Resume' : 'Play'} ${chapter.title}`);
  }
  if (!parent.children.length) el('p', 'No matching chapters.', parent);
}
$('chapter-search').oninput = renderChapters;
async function browseChapter(book, edition, chapter, canPlay = true) {
  const version = ++browseVersion;
  try {
    const text = await api(`/stories/${book.id}/${edition}/text/${chapter.assembly}`);
    if (version !== browseVersion) return;
    browsed = { book, edition, chapter, canPlay }; browseReading = text; $('toggle').disabled = !playing && !canPlay;
    $('player').hidden = false; $('reader-empty').hidden = true; setFollow(false); renderPassages(); renderPlayback(); view('reading');
  } catch (error) { say(`Text could not load: ${error.message}. Your audio has not moved.`); }
}
async function passageSeek(seconds) {
  if (browsed?.canPlay === false) { say('Audio isn’t ready in this edition. Your current audio has not moved.'); return; }
  if (browsed) { const target = browsed; await play(target.book, target.edition, target.chapter, seconds, !audio.paused, 'passage'); }
  else seek(seconds, 'passage');
}

async function flush() {
  if (flushing || !local) return;
  flushing = true;
  try {
    while (local.pending.length) { const event = local.pending[0]; await api('/progress', event); local.pending.shift(); persist(); }
    while (local.issueQueue?.length) { const event = local.issueQueue[0]; await api('/issues', event); local.issueQueue.shift(); persist(); }
    if (/^\d+ locations saved on this device/.test($('message').textContent)) say('Your listening positions are synced.');
  } catch { say(`${local.pending.length + (local.issueQueue?.length || 0)} changes saved in this browser. Sync will retry when connected.`); }
  finally { flushing = false; }
}
function save(reason = 'pause', from, completed = false) {
  if (!playing || switching || !local) return;
  const progress = { ...locationOf(), eventId: crypto.randomUUID(), deviceTime: Date.now(), reason, completed, ...(from ? { from: wireLocation(from) } : {}) };
  local.pending.push(progress);
  const key = `${playing.book.id}:${playing.edition}:${playing.chapter.id}`;
  local.positions[key] = progress; local.selected = progress;
  if (from && ['seek', 'passage', 'chapter', 'restore'].includes(reason)) { local.undo = from; local.jumps ||= []; local.jumps.push({ eventId: progress.eventId, deviceTime: progress.deviceTime, from }); }
  persist(); lastSaved = Date.now(); $('undo').disabled = !local.undo;
  if (completed) library.state.completed[`${playing.book.id}:${playing.chapter.id}`] = true;
  flush();
}
function renderLibrary() {
  $('library').replaceChildren(); $('continue').replaceChildren();
  const stories = new Map(library.books.map(book => [book.id, book]));
  for (const story of catalog?.stories || []) if (story.follow && !stories.has(story.id)) stories.set(story.id, story);
  const latest = playing?.book.id || local.selected?.story;
  const query = $('library-search').value.trim().toLowerCase();
  for (const book of stories.values()) {
    const info = book.editions ? summary(book) : undefined, started = !!info?.latest || playing?.book.id === book.id;
    if (!`${book.title} ${book.author}`.toLowerCase().includes(query) || libraryFilter !== 'All' && (libraryFilter === 'In progress') !== started) continue;
    const featured = !query && libraryFilter === 'All' && book.id === latest;
    if (featured) el('h2', 'Keep listening', $('continue'));
    const row = el('article', null, featured ? $('continue') : $('library')); row.className = 'story-row' + (featured ? ' featured' : '');
    const source = catalog?.stories.find(s => s.id === book.id);
    if (source?.hasCover) { const img = el('img', null, row); img.src = `/listen/stories/${book.id}/cover`; img.alt = ''; img.loading = 'lazy'; }
    const content = el('div', null, row); const heading = el('h2', null, content);
    const link = el('a', book.title, heading); link.href = `#story/${encodeURIComponent(book.id)}`;
    link.onclick = event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); openStory(book.id); } };
    el('p', book.author, content);
    if (info) {
      const chapter = info.latest && findLocation(info.latest)?.chapter;
      el('p', chapter ? `${chapter.title} · ${time(chapterView(chapter).position(info.latest.seconds))}` : 'Not started', content).className = 'fine';
      el('p', `${unreadAudio(info.unread.length)} · ${time(info.remaining)} left`, content).className = 'fine';
      const start = button('', row, () => info.latest ? openLocation(info.latest, true, 'chapter') : play(book, info.edition, info.chapters[0], 0, true, 'chapter')); start.className = 'icon'; start.disabled = !info.chapters.length; icon(start, 'play_arrow', `${started ? 'Continue' : 'Play'} ${book.title}`);
    } else el('p', 'Audio is preparing', content).className = 'fine';
  }
  if (!$('library').children.length && !$('continue').children.length) el('p', stories.size ? 'No matching books. Try another title or author.' : 'No books yet. Your prepared stories will appear here.', $('library'));
  renderIssues();
}
$('library-search').oninput = renderLibrary;
for (const filter of $('library-filters').children) filter.onclick = () => { libraryFilter = filter.textContent; for (const item of $('library-filters').children) item.setAttribute('aria-pressed', String(item === filter)); renderLibrary(); };
function renderIssues() {
  if (!library || !local) return;
  const selected = $('issue-book').value; $('issue-book').replaceChildren(); el('option', 'All books', $('issue-book')).value = '';
  for (const book of library.books) el('option', book.title, $('issue-book')).value = book.id;
  $('issue-book').value = selected;
  const pending = (local.issueQueue || []).map(i => ({ ...i, id: i.eventId, status: 'pending' }));
  const issues = [...pending, ...library.state.issues.filter(i => !pending.some(p => p.eventId === i.eventId))];
  $('issues').replaceChildren();
  for (const issue of issues.reverse()) {
    if (selected && issue.story !== selected || issueFilter !== 'All' && issue.status !== issueFilter.toLowerCase()) continue;
    const row = el('article', null, $('issues')); row.className = 'issue';
    const text = el('div', null, row); el('strong', `${library.books.find(b => b.id === issue.story)?.title || 'Book'} · ${issue.edition} · ${time(issue.seconds)}`, text); el('p', issue.note || issue.kind, text);
    if (issue.status === 'pending') el('small', 'Saved here · waiting to sync', text);
    const check = button('', row, async () => {
      check.disabled = true;
      try { await api('/issues/resolve', { id: issue.id, resolved: issue.status === 'open' }); issue.status = issue.status === 'open' ? 'resolved' : 'open'; renderIssues(); await refresh(); }
      finally { check.disabled = !connected || !capabilities.manageLibrary; }
    }); check.className = 'icon'; icon(check, issue.status === 'resolved' ? 'check_circle' : 'check_circle_outline', issue.status === 'resolved' ? 'Reopen issue' : 'Resolve issue'); check.setAttribute('aria-pressed', String(issue.status === 'resolved')); check.disabled = issue.status === 'pending' || !connected || !capabilities.manageLibrary;
  }
  if (!$('issues').children.length) el('p', 'No matching issues.', $('issues'));
}
$('issue-book').onchange = renderIssues;
for (const filter of $('issue-filters').children) filter.onclick = () => { issueFilter = filter.textContent; for (const item of $('issue-filters').children) item.setAttribute('aria-pressed', String(item === filter)); renderIssues(); };

async function refresh() {
  await flush(); const next = await api('/library');
  if (library && next.accountKey !== library.accountKey) { audio.pause(); location.reload(); return; }
  capabilities = (await api('/capabilities').catch(() => ({}))).permissions || {}; connected = true; library = next; storageKey = `listener:${library.accountKey}`;
  if (!local) { try { local = JSON.parse(localStorage.getItem(storageKey)); } catch {} local ||= { positions: {}, pending: [] }; }
  for (const [key, value] of Object.entries(library.state.positions)) if (!local.positions[key] || value.deviceTime > local.positions[key].deviceTime) local.positions[key] = value;
  persist(); renderLibrary();
  say(library.books.length ? 'Ready to listen.' : 'Your chapters will appear here when generation finishes.');
  await flush();
  await refreshCatalog();
}
function setFollow(value) { follow = value; $('follow').textContent = follow && !browsed ? 'Following audio' : 'Back to audio'; $('follow').setAttribute('aria-pressed', String(follow)); if (follow) highlight(true); }
function highlight(force = false) {
  if (!reading || browsed) return;
  let index = 0; for (let i = 0; i < visiblePassages.length; i++) { if (visiblePassages[i].start <= audio.currentTime) index = i; else break; }
  if (index === activePassage && !force) return;
  $('passages').children[activePassage]?.removeAttribute('aria-current'); activePassage = index;
  const current = $('passages').children[index]; current?.setAttribute('aria-current', 'true');
  $('passage-label').textContent = visiblePassages.length ? `Passage ${index + 1} of ${visiblePassages.length} · ${time(chapterView().position(audio.currentTime))}` : '';
  if (follow && current) {
    const page = $('passages'), rect = current.getBoundingClientRect(), viewport = page.getBoundingClientRect();
    if (rect.top < viewport.top || rect.bottom > viewport.bottom) page.scrollTo({ top: page.scrollTop + rect.top - viewport.top - 12, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
}
function seek(seconds, reason = 'seek') {
  if (!playing || switching) return;
  const from = undoLocation(), autoplay = !audio.paused, target = notePosition(seconds); if (target < playing.chapter.duration - .100001) chapterEndHandled = false; programmedSeek = true; audio.currentTime = target; stableSeconds = audio.currentTime;
  save(reason, from); setFollow(true); highlight(true); renderPlayback();
  if (!includeAuthorNotes && audio.currentTime >= playing.chapter.duration) finishChapter(autoplay);
}
function notePosition(seconds) {
  const view = chapterView();
  return view.source(view.position(seconds));
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
  if (next) play(playing.book, playing.edition, next, 0, autoplay, 'playing').catch(error => say(error.message));
  else { audio.pause(); renderLibrary(); }
}
async function checkedRecording(book, edition, chapter, signal) {
  const response = await fetch(`/listen/stories/${book.id}/${edition}/audio/${chapter.assembly}`, { method: 'HEAD', signal });
  if (!response.ok) throw new Error('This recording is unavailable. Your current audio has not moved.');
}
async function play(book, edition, chapter, seconds = 0, autoplay = false, reason = 'restore', reveal = true, undoRestore = false, guard = () => true, prepared) {
  const requestId = ++playRequest;
  // Resolve text and verify the recording before replacing the current player.
  const preparedText = prepared;
  await checkedRecording(book, edition, chapter);
  if (requestId !== playRequest || !guard()) return;
  browsed = undefined; $('toggle').disabled = false; browseVersion++;
  prepareNoteOutput();
  const from = undoLocation(); save('pause'); switching = true; audio.pause(); const version = ++loadVersion;
  clearTimeout(noteTimer);
  readingRequest?.abort(); const request = new AbortController(); readingRequest = request; readingPending = true;
  const textTimeout = setTimeout(() => request.abort(), 10000);
  playing = { book, edition, chapter }; reading = undefined; visiblePassages = []; seekDraft = undefined; activePassage = -1; chapterEndHandled = false; loadAutoplay = autoplay;
  updateNoteOutput();
  $('player').hidden = false; $('reader-empty').hidden = true; $('book-title').textContent = book.title; $('chapter-title').textContent = chapter.title;
  $('edition-label').textContent = `${editionNames[edition] || edition} edition`; $('passages').replaceChildren(); $('reader-status').textContent = 'Loading the generated passages…'; $('source-link').hidden = true;
  if (reveal) view('reading'); renderMiniPlayer(); setFollow(true); $('undo').disabled = !local.undo;
  let metadataReady = false, textReady = false, started = false;
  const ready = () => {
    if (version !== loadVersion || !metadataReady || (!includeAuthorNotes && !textReady)) return;
    if (!started) {
      started = true;
      programmedSeek = true; audio.currentTime = notePosition(undoRestore ? chapterView().undoPosition(seconds, reading?.passages) : seconds); stableSeconds = audio.currentTime;
      audio.playbackRate = Number($('speed').value); switching = false; save(reason, ['chapter', 'passage'].includes(reason) || reason === 'restore' && reveal ? from : undefined); highlight(true); renderPlayback();
    } else if (!includeAuthorNotes) { skipNotes(loadAutoplay); if (version !== loadVersion || chapterEndHandled) return; }
    const requested = loadAutoplay; loadAutoplay = false;
    if (!includeAuthorNotes && audio.currentTime >= chapter.duration) finishChapter(requested);
    else if (requested) audio.play().catch(error => { if (version === loadVersion && error.name !== 'AbortError') say(error.message); });
  };
  releasePlayback = ready;
  audio.onloadedmetadata = () => { metadataReady = true; ready(); };
  audio.src = `/listen/stories/${book.id}/${edition}/audio/${chapter.assembly}`;
  try {
    const text = preparedText || await api(`/stories/${book.id}/${edition}/text/${chapter.assembly}`, undefined, request.signal); if (version !== loadVersion) return; reading = text;
    renderPassages(); renderPlayback();
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
async function openLocation(value, autoplay = false, reason = 'restore', reveal = true, undoRestore = false, guard = () => true) {
  let found = findLocation(value);
  if (!found) {
    const book = library.books.find(b => b.id === value.story); if (!book) throw new Error('This story is no longer in the library.');
    const text = await api(`/stories/${value.story}/${value.edition}/text/${value.assembly}`);
    found = { book, chapter: value.selection?.chapter || { id: text.chapterId, sequence: text.sequence, title: text.title, checksum: text.checksum, duration: text.duration, assembly: value.assembly } };
  }
  await play(found.book, value.edition, found.chapter, value.seconds, autoplay, reason, reveal, undoRestore, guard);
}
function renderJumps(entries) {
  $('history').replaceChildren();
  for (const entry of entries.filter(e => e.from?.story === playing?.book.id).sort((a,b) => b.deviceTime - a.deviceTime)) {
    const point = entry.from, row = el('article', null, $('history')); row.className = 'history-entry';
    el('h3', `${point.chapterTitle || 'Saved passage'} · ${time(point.seconds)}`, row);
    el('p', `${editionNames[point.edition] || point.edition} · ${new Date(entry.deviceTime).toLocaleString()}`, row).className = 'fine';
    if (point.excerpt) el('p', point.excerpt, row);
    const restore = button('Return here', row, () => returnTo(point)); restore.disabled = !connected; if (!connected) el('small', 'Connect to return to this recording.', row);
  }
  if (!$('history').children.length) el('p', 'Places you leave when you jump will appear here.', $('history'));
}
async function loadHistory(earlier = false) {
  if (!playing) return;
  const story = playing.book.id;
  if (!earlier) { historyBefore = undefined; $('history-status').textContent = ''; renderJumps((local.jumps || []).concat(local.remoteJumps || [])); }
  const result = await api(`/history?story=${story}&jumps=1` + (earlier && historyBefore ? `&before=${historyBefore}` : ''));
  if (playing?.book.id !== story) return;
  const cached = earlier ? (local.remoteJumps || []) : (local.remoteJumps || []).filter(e => e.from?.story !== story);
  local.remoteJumps = [...new Map([...cached, ...result.entries].map(e => [e.eventId, e])).values()]; persist();
  const entries = [...new Map([...(local.jumps || []), ...local.remoteJumps].map(e => [e.eventId, e])).values()];
  renderJumps(entries); historyBefore = result.before; $('more-history').hidden = !historyBefore;
}
$('more-history').onclick = () => loadHistory(true).catch(error => say(error.message));
async function returnTo(value) {
  const generation = ++returnGeneration, autoplay = !audio.paused;
  $('history-status').textContent = 'Opening the saved recording…';
  try { await openLocation(value, autoplay, 'restore', true, true, () => generation === returnGeneration); if (generation === returnGeneration) { $('history-dialog').close(); $('history-status').textContent = ''; } }
  catch (error) { if (generation === returnGeneration) $('history-status').textContent = 'That recording is unavailable. Your audio has not moved. Try again.'; }
}
$('undo').onclick = () => { if (local.undo) returnTo(local.undo); };
$('open-history').onclick = () => { openDialog($('history-dialog')); loadHistory().catch(error => { $('history-status').textContent = 'Showing locations saved on this browser. Sync is unavailable.'; }); };
$('follow').onclick = () => { browsed = undefined; browseVersion++; renderPassages(); setFollow(true); };
for (const event of ['wheel', 'touchstart', 'pointerdown']) $('passages').addEventListener(event, () => setFollow(false), { passive: true });
$('passages').addEventListener('keydown', event => { if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) setFollow(false); });
$('text-size').value = localStorage.getItem('listener:book-text-size') || '14';
function textSize() { const size = Math.min(28, Math.max(12, Number($('text-size').value) || 14)); $('text-size').value = size; $('passages').style.setProperty('--reader-size', `${size}px`); $('font-example').style.fontSize = `${size}px`; localStorage.setItem('listener:book-text-size', size); }
$('text-smaller').onclick = () => { $('text-size').value = Math.max(12, Number($('text-size').value) - 2); textSize(); };
$('text-larger').onclick = () => { $('text-size').value = Math.min(28, Number($('text-size').value) + 2); textSize(); }; textSize();
for (let tenth = 8; tenth <= 25; tenth++) { const option = el('option', `${tenth / 10}×`, $('speed')); option.value = tenth / 10; }
function setSpeed(value) {
  if (!Number.isFinite(value) || value < .1 || value > 4) return;
  if (![...$('speed').options].some(o => Number(o.value) === value)) { const option = el('option', `${value}×`, $('speed')); option.value = value; }
  $('speed').value = value; $('custom-speed').value = value; $('open-speed').textContent = `${value}×`; audio.playbackRate = value; localStorage.setItem('listener:speed', value);
}
setSpeed(Number(localStorage.getItem('listener:speed')) || 1);
$('speed').onchange = () => { setSpeed(Number($('speed').value)); $('speed-dialog').close(); };
$('custom-speed-form').onsubmit = event => { event.preventDefault(); if ($('custom-speed').checkValidity()) { setSpeed(Number($('custom-speed').value)); $('speed-dialog').close(); } };
$('open-speed').onclick = () => openDialog($('speed-dialog'));
$('settings').onclick = () => {
  if (page === 'preparation') { openPreparationSettings(); return; }
  $('edition').replaceChildren();
  for (const [name, data] of Object.entries(playing?.book.editions || {})) { const option = el('option', editionNames[name] || name, $('edition')); option.value = name; option.disabled = !data.chapters.some(c => c.id === playing.chapter.id); }
  $('edition').value = playing?.edition || ''; openDialog($('listening-settings'));
};
$('edition').onchange = () => switchEdition($('edition').value).catch(error => { $('edition').value = playing?.edition || ''; say(error.message); });
$('include-author-notes').checked = includeAuthorNotes;
$('include-author-notes').onchange = () => { includeAuthorNotes = $('include-author-notes').checked; localStorage.setItem('listener:include-author-notes', String(includeAuthorNotes)); seekDraft = undefined; renderPassages(); prepareNoteOutput(); if (!includeAuthorNotes && readingPending) { if (!switching) loadAutoplay = !audio.paused; audio.pause(); } else { releasePlayback?.(); skipNotes(); } scheduleNotes(); renderPlayback(); renderMiniPlayer(); if (library) { renderLibrary(); if (page === 'story') renderStory(); } };

async function movePlayback(delta) {
  if (!playing) return;
  const { book, edition, chapter } = playing, chapters = book.editions[edition].chapters;
  let index = chapters.findIndex(c => c.assembly === chapter.assembly), view = chapterView(), position = view.position(audio.currentTime) + delta;
  while (position < 0 && index > 0) { index--; view = chapterView(chapters[index]); position += view.duration; }
  while (position > view.duration && index < chapters.length - 1) { position -= view.duration; index++; view = chapterView(chapters[index]); }
  const target = view.source(position);
  if (chapters[index].assembly === chapter.assembly) seek(target);
  else { try { await play(book, edition, chapters[index], target, !audio.paused, 'chapter'); } catch (error) { say(error.message); } }
}
$('back').onclick = () => movePlayback(-15); $('forward').onclick = () => movePlayback(30);
$('toggle').onclick = () => { if (!playing && browsed) return play(browsed.book, browsed.edition, browsed.chapter, 0, true, 'chapter'); prepareNoteOutput(); return audio.paused ? audio.play().catch(error => say(error.message)) : audio.pause(); };
$('chapter-position').oninput = () => { seekDraft = Number($('chapter-position').value); renderPlayback(); };
$('chapter-position').onchange = () => { const target = Number($('chapter-position').value); seekDraft = undefined; seek(chapterView().source(target)); renderPlayback(); };
$('chapter-position').onpointercancel = () => { seekDraft = undefined; renderPlayback(); };

function adjacent(delta) { if (!playing) return; const chapters = playing.book.editions[playing.edition].chapters; const chapter = chapters[chapters.findIndex(c => c.assembly === playing.chapter.assembly) + delta]; if (chapter) return play(playing.book, playing.edition, chapter, 0, !audio.paused, 'chapter'); }
if (navigator.mediaSession) {
  const actions = { play: () => $('toggle').click(), pause: () => audio.pause(), seekbackward: event => movePlayback(-(event.seekOffset || 15)), seekforward: event => movePlayback(event.seekOffset || 30), seekto: event => seek(chapterView().source(event.seekTime)), previoustrack: () => adjacent(-1), nexttrack: () => adjacent(1) };
  for (const [name, action] of Object.entries(actions)) { try { navigator.mediaSession.setActionHandler(name, action); } catch {} }
}

audio.ontimeupdate = () => { if (skipNotes()) return; scheduleNotes(); renderPlayback(); renderMiniPlayer(); highlight(); if (!switching && !audio.seeking) { stableSeconds = audio.currentTime; if (!audio.paused && Date.now() - lastSaved > 5000) save('playing'); } };
audio.onseeking = () => { updateNoteOutput(); if (!switching && !programmedSeek) { if (notePosition(audio.currentTime) < playing.chapter.duration - .100001) chapterEndHandled = false; if (!seekOrigin) seekOrigin = locationOf(chapterView().undoPosition(stableSeconds, reading?.passages)); } };
audio.onseeked = () => { const from = seekOrigin, assembly = playing?.chapter.assembly; seekOrigin = undefined; if (skipNotes()) { if (from && playing?.chapter.assembly === assembly) save('seek', from); return; } if (programmedSeek) programmedSeek = false; else if (from) save('seek', from); stableSeconds = audio.currentTime; highlight(true); scheduleNotes(); renderPlayback(); };
audio.onpause = () => { updateNoteOutput(); clearTimeout(noteTimer); save('pause'); renderPlayback(); renderMiniPlayer(); };
audio.onplay = () => { prepareNoteOutput(); if (switching || (!includeAuthorNotes && readingPending)) { loadAutoplay = true; audio.pause(); return; } skipNotes(true); scheduleNotes(); renderPlayback(); renderMiniPlayer(); };
audio.onratechange = scheduleNotes;
audio.onended = () => finishChapter();
audio.onerror = () => { switching = false; say('Audio could not load. Check your connection and sign in again if needed.'); };

$('refresh').onclick = () => refresh().catch(error => say(error.message));
window.addEventListener('online', flush); document.addEventListener('visibilitychange', () => { if (document.hidden) save('pause'); }); window.addEventListener('pagehide', () => save('pause'));
function saveDraft() { if (!issueDraft) return; issueDraft.kind = $('kind').value; issueDraft.note = $('note').value; local.drafts ||= {}; local.drafts[issueDraft.story] = issueDraft; persist(); }
$('mark-issue').onclick = () => {
  if (!playing) return;
  audio.pause(); local.drafts ||= {};
  issueDraft = local.drafts[playing.book.id] || { ...richLocation(), eventId: crypto.randomUUID(), kind: 'delivery', note: '' };
  $('kind').value = issueDraft.kind; $('note').value = issueDraft.note; $('issue-error').textContent = '';
  $('issue-excerpt').textContent = issueDraft.excerpt || '';
  $('issue-location').textContent = `${issueDraft.selection?.book.title || ''} · ${issueDraft.chapterTitle} · ${time(issueDraft.seconds)} · ${editionNames[issueDraft.edition] || issueDraft.edition}`;
  try { saveDraft(); openDialog($('issue-dialog')); } catch { say('Couldn’t save a draft in this browser. Check available storage.'); }
};
$('kind').onchange = $('note').oninput = () => { try { saveDraft(); $('issue-error').textContent = ''; } catch { $('issue-error').textContent = 'Couldn’t keep the draft in this browser. Your text stays open. Try saving again.'; } };
$('cancel-issue').onclick = () => { saveDraft(); $('issue-dialog').close(); };
$('discard-issue').onclick = () => { delete local.drafts[issueDraft.story]; persist(); issueDraft = undefined; $('issue-dialog').close(); };
$('issue-dialog').addEventListener('cancel', () => saveDraft());
$('issue').onsubmit = event => {
  event.preventDefault(); if (!issueDraft) return;
  try {
    saveDraft(); const queued = { ...wireLocation(issueDraft), eventId: issueDraft.eventId, kind: issueDraft.kind, note: issueDraft.note };
    local.issueQueue ||= []; if (!local.issueQueue.some(i => i.eventId === queued.eventId)) local.issueQueue.push(queued);
    // One durable write records the event and removes its draft; failure restores it.
    const draft = local.drafts[issueDraft.story]; delete local.drafts[issueDraft.story];
    try { persist(); } catch (error) { local.drafts[issueDraft.story] = draft; throw error; }
    issueDraft = undefined; $('issue-dialog').close(); renderIssues(); say('Issue saved on this browser. Sync will retry when connected.'); flush().then(() => refresh().catch(() => {}));
  } catch { $('issue-error').textContent = 'Couldn’t save here. Your draft is kept. Free some storage and try again.'; }
};

const code = new URLSearchParams(location.search).get('code');
if (location.pathname === '/listen/pair' && /^[A-F0-9]{10}$/.test(code ?? '')) { $('pair').hidden = false; $('code').textContent = code; $('approve').onclick = async () => { try { await api('/pair/approve', { code }); $('approve').disabled = true; say('Connected. Return to your Android listener.'); } catch (error) { say(error.message); } }; }
refresh().then(() => { const latest = Object.values(local.positions).sort((a, b) => b.deviceTime - a.deviceTime)[0]; if (latest && !code) return openLocation(latest, false, 'restore', false); }).then(async () => { await initialNavigation; route(); }).catch(error => say(error.message));


async function refreshCatalog() {
  try { catalog = await api('/catalog'); renderLibrary(); if (page === 'story') renderStory(); if (page === 'preparation') renderPreparation(); }
  catch (error) { connected = false; if (page === 'preparation') renderPreparation(); }
}
function renderPreparation() {
  const parent = $('preparation'); parent.replaceChildren();
  const story = catalog?.stories.find(s => s.id === selectedStoryId);
  if (!story) { el('p', 'Preparation information is unavailable. Sync to retry.', parent); return; }
  const mayWrite = capabilities.manageLibrary && capabilities.generate && connected && story.supported !== false;
  el('h2', story.title, parent);
  el('p', `${story.chapters.filter(c => c.editions.includes('qwen')).length} of ${story.chapters.length} chapters published with Qwen audio`, parent);
  if (!connected) el('p', 'Offline · showing the last reported preparation state', parent);
  for (const job of (catalog.jobs || []).filter(j => j.story === story.id)) {
    const row = el('article', null, parent); row.className = 'queue-job'; el('strong', job.cancel && !['cancelled', 'complete', 'failed'].includes(job.status) ? 'Cancellation requested' : job.status, row); el('p', job.phase || '', row); if (job.error) el('p', job.error, row);
    const action = ['queued', 'running', 'waiting'].includes(job.status) && !job.cancel ? 'cancel' : ['failed', 'cancelled', 'waiting'].includes(job.status) ? 'retry' : undefined;
    if (action) { const change = button(action === 'cancel' ? 'Cancel job' : 'Retry now', row, async () => { change.disabled = true; try { await api('/jobs', { id: job.id, action }); await refreshCatalog(); } finally { change.disabled = !mayWrite; } }); change.disabled = !mayWrite; }
  }
  if (story.repair) renderRepair(story.repair, parent);
  el('p', story.follow?.enabled ? `Automatic checks every ${story.follow.intervalHours} hours` : 'Automatic checks paused', parent);
  if (!story.follow) el('p', 'Set up audio preparation in an agent session.', parent);
  if (story.follow) { const check = button('Check now', parent, async () => { check.disabled = true; try { await api('/check', { story: story.id }); await refreshCatalog(); } finally { check.disabled = !mayWrite; } }); check.disabled = !mayWrite; }
  for (const chapter of story.chapters) { const row = el('div', null, parent); row.className = 'chapter'; el('strong', chapter.title, row); el('small', chapter.editions.length ? `Published: ${chapter.editions.map(e => editionNames[e] || e).join(', ')}` : chapter.downloaded ? 'Text ready · audio not published' : chapter.availability === 'locked' ? 'Locked at source' : 'Text not ready', row); }
}
let preparationTarget;
function openPreparationSettings() {
  const story = catalog?.stories.find(s => s.id === selectedStoryId); if (!story) return;
  preparationTarget = { ...story, follow: story.follow && { ...story.follow } };
  $('automatic-checks').checked = !!story.follow?.enabled; $('preparation-mode').value = story.follow?.mode || 'buffer';
  const enabled = !!story.follow && capabilities.manageLibrary && connected && story.supported !== false;
  for (const field of $('save-preparation').querySelectorAll('input,select,button[type=submit],button:not([type])')) field.disabled = !enabled;
  for (const option of $('preparation-mode').options) option.disabled = !capabilities.generate && option.value !== 'download';
  $('preparation-error').textContent = enabled ? '' : !story.follow ? 'Set up this book in an agent session first.' : !connected ? 'Connect to save preparation settings.' : 'Preparation settings are read only.';
  openDialog($('preparation-settings'));
}
$('save-preparation').onsubmit = async event => {
  event.preventDefault(); const story = preparationTarget; if (!story?.follow || !capabilities.manageLibrary || !connected || !capabilities.generate && $('preparation-mode').value !== 'download') return;
  const submit = $('save-preparation').querySelector('button:not([type])'); submit.disabled = true;
  try { await api('/follow', { url: story.url, enabled: $('automatic-checks').checked, mode: $('preparation-mode').value, buffer: 5, intervalHours: story.follow.intervalHours }); await refreshCatalog(); $('preparation-settings').close(); }
  catch (error) { $('preparation-error').textContent = error.message; } finally { submit.disabled = false; }
};
setInterval(() => { if (library && !document.hidden) refreshCatalog(); }, 30000);
window.addEventListener('offline', () => { connected = false; renderIssues(); say('Offline · changes are saved in this browser.'); });
window.addEventListener('online', () => refresh().catch(error => say(error.message)));

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

function samePassagePosition(current, target, seconds) {
  const node = current.passages.findLast(p => p.start <= seconds) || current.passages[0];
  if (!node) throw new Error('Passage timing is unavailable. Your audio has not moved.');
  const fraction = Math.min(1, Math.max(0, (seconds - node.start) / Math.max(.001, node.end - node.start)));
  let match = target.passages.find(p => p.id === node.id && p.text === node.text);
  if (match) return match.start + fraction * (match.end - match.start);
  if (current.source && current.source === target.source && node.endOffset > node.startOffset) {
    const offset = node.startOffset + fraction * (node.endOffset - node.startOffset);
    match = target.passages.find(p => p.endOffset > p.startOffset && offset >= p.startOffset && offset < p.endOffset);
    if (match) return match.start + (offset - match.startOffset) / (match.endOffset - match.startOffset) * (match.end - match.start);
  }
  throw new Error('This passage is unavailable in that edition. Your audio has not moved.');
}
let editionRequest = 0;
async function switchEdition(edition) {
  if (!playing || edition === playing.edition) return;
  const current = playing, generation = ++editionRequest;
  const chapter = current.book.editions[edition]?.chapters.find(c => c.id === current.chapter.id);
  if (!chapter || !reading) throw new Error('This chapter is unavailable in that edition.');
  $('edition').disabled = true;
  try {
    const target = await api(`/stories/${current.book.id}/${edition}/text/${chapter.assembly}`);
    if (generation !== editionRequest || playing !== current) return;
    const seconds = samePassagePosition(reading, target, audio.currentTime), autoplay = !audio.paused;
    // Edition changes are recorded as progress, never as a jump.
    await play(current.book, edition, chapter, seconds, autoplay, 'playing', true, false, () => generation === editionRequest && playing === current, target);
    $('edition').value = playing.edition;
  } finally { $('edition').disabled = false; }
}
$('audio-output').onclick = async () => {
  openDialog($('output-dialog')); $('outputs').hidden = true; $('choose-output').hidden = true;
  if (typeof audio.setSinkId !== 'function') { $('output-status').textContent = 'Choose a Bluetooth or other audio device in your system’s sound settings. This browser does not support choosing audio output here.'; return; }
  $('output-status').textContent = 'Choose the device for this player.';
  if (navigator.mediaDevices?.selectAudioOutput) {
    $('choose-output').hidden = false;
    $('choose-output').onclick = async () => { try { const device = await navigator.mediaDevices.selectAudioOutput(); await audio.setSinkId(device.deviceId); $('output-status').textContent = device.label || 'Audio device selected'; } catch (error) { $('output-status').textContent = error.name === 'NotAllowedError' ? 'No device selected. You can try again.' : 'Couldn’t change the audio device. Try again or use system sound settings.'; } };
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices(); $('outputs').replaceChildren();
    for (const device of devices.filter(d => d.kind === 'audiooutput')) { const option = el('option', device.label || (device.deviceId === 'default' ? 'System default' : 'Audio device'), $('outputs')); option.value = device.deviceId; }
    $('outputs').hidden = !$('outputs').options.length; $('outputs').value = audio.sinkId || 'default';
    $('outputs').onchange = async () => { try { await audio.setSinkId($('outputs').value); $('output-status').textContent = 'Audio device selected'; } catch { $('output-status').textContent = 'Couldn’t change the audio device. Your current output is kept.'; } };
  } catch { $('output-status').textContent = 'Use system sound settings to change your audio device.'; }
};
