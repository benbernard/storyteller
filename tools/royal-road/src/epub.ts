import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'cheerio';
import { zipSync, strToU8, type Zippable } from 'fflate';
import { atomicFile, atomicJson, readJson, type Manifest } from './download.js';
import { cleanHtml, hash, type Chapter, type ChapterArchive, type ImageRef } from './pages.js';
import { epubImage } from './epub-images.js';

export interface EditionChapter {
  chapterId: string; title: string; url: string; href: string; contentHash: string | null;
  availability: string; saved: boolean;
}
export interface Edition {
  schemaVersion: 1; fictionId: string; title: string; author: string; id: string;
  sha256: string; bytes: number; createdAt: string; chapters: EditionChapter[]; mediaErrors: number;
}
const keyPattern = /^[a-f0-9]{64}$/;
const idPattern = /^rr-\d+$/;
const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const document = (title: string, body: string) => `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en"><head><title>${xml(title)}</title><link rel="stylesheet" href="style.css"/></head><body>${body}</body></html>`;

/** The spine has exactly one item per chapter, including unavailable placeholders.
 * This makes DocFragment indices unambiguous without inferring progress from a percentage. */
export async function exportEpub(root: string, fictionId: string, signal?: AbortSignal): Promise<Edition> {
  signal?.throwIfAborted();
  if (!idPattern.test(fictionId)) throw new Error('Invalid fiction ID.');
  const directory = join(root, fictionId);
  const manifest = await readJson<Manifest>(join(directory, 'manifest.json'));
  if (!manifest || !manifest.complete) throw new Error('Finish the chapter download before publishing an edition.');
  const archive = manifest.archive ?? manifest.fiction.chapters;
  if (!archive.length) throw new Error('No chapters to export.');
  const fingerprint = hash(JSON.stringify({ version: 6, fiction: manifest.fiction, archive, current: manifest.current, details: manifest.details, cover: manifest.cover }));
  const previous = await readJson<Edition>(join(directory, 'edition.json'));
  if (previous?.id === fingerprint) {
    const bytes = await readFile(join(directory, 'editions', `${fingerprint}.epub`)).catch(() => undefined);
    if (bytes && hash(bytes) === previous.sha256) return previous;
  }
  const files: Zippable = {};
  const add = (name: string, value: string | Uint8Array, stored = false) => {
    files[name] = [typeof value === 'string' ? strToU8(value) : value, { level: stored ? 0 : 6, mtime: new Date(2000, 0, 1) }];
  };
  add('mimetype', 'application/epub+zip', true);
  add('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  add('OEBPS/style.css', 'body{line-height:1.5}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #777;padding:.3em}aside{font-size:.9em}h1{page-break-before:always}.notice{font-style:italic}');
  const assets = new Map<string, { name: string; mime: string; cover: boolean }>();
  const embeddedAssets = new Map<string, { name: string; mime: string; cover: boolean }>();
  let mediaErrors = 0;
  const image = async (ref: ImageRef, cover = false): Promise<string | undefined> => {
    signal?.throwIfAborted();
    if (!ref.asset || !keyPattern.test(ref.asset)) { mediaErrors++; return; }
    const existing = assets.get(ref.asset);
    if (existing) { existing.cover ||= cover; return existing.name; }
    const bytes = await readFile(join(directory, 'assets', ref.asset));
    if (hash(bytes) !== ref.asset) throw new Error('Saved image failed its integrity check.');
    let embedded;
    try { embedded = await epubImage(bytes); }
    catch { signal?.throwIfAborted(); mediaErrors++; return; }
    signal?.throwIfAborted();
    const embeddedHash = hash(embedded.bytes);
    let asset = embeddedAssets.get(embeddedHash);
    if (asset) asset.cover ||= cover;
    else {
      asset = {name:`images/${embeddedHash}.${embedded.extension}`,mime:embedded.mime,cover};
      embeddedAssets.set(embeddedHash,asset);add(`OEBPS/${asset.name}`,embedded.bytes);
    }
    assets.set(ref.asset,asset);return asset.name;
  };
  if (manifest.cover) await image(manifest.cover, true);
  const render = async (html: string, images: ImageRef[], sourceUrl: string) => {
    const $ = load(cleanHtml(html), {}, false);
    // Some author notes nest lists directly, which is invalid EPUB XHTML.
    $('ul > ul, ul > ol, ol > ul, ol > ol').wrap('<li></li>');
    for (const el of $('img').toArray()) {
      const match = /^\/pending-image\/(\d+)$/.exec($(el).attr('src') ?? '');
      const ref = match ? images[Number(match[1])] : undefined;
      const path = ref ? await image(ref) : undefined;
      if (path) $(el).attr('src', path);
      else $(el).replaceWith($('<p class="notice"></p>').text(`Image unavailable${ref?.alt ? `: ${ref.alt}` : ''}`));
    }
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href')!;
      try { $(el).attr('href', new URL(href, sourceUrl).href); } catch { $(el).removeAttr('href'); }
    });
    return $.xml();
  };
  const chapters: EditionChapter[] = [];
  let modifiedAt = "1980-01-01T00:00:00.000Z";
  for (const link of archive) {
    signal?.throwIfAborted();
    if (!idPattern.test(link.chapterId)) throw new Error('Invalid chapter ID.');
    const key = manifest.current[link.chapterId];
    const href = `${link.chapterId}.xhtml`;
    let body = `<h1>${xml(link.title)}</h1>`;
    let chapter: Chapter | undefined;
    if (key) {
      if (!keyPattern.test(key)) throw new Error('Invalid chapter revision.');
      chapter = await readJson<Chapter>(join(directory, 'revisions', `${key}.json`));
      if (!chapter || hash(JSON.stringify(chapter)) !== key || hash(chapter.text) !== chapter.contentHash || chapter.chapterId !== link.chapterId || chapter.fictionId !== fictionId) throw new Error('Saved chapter failed its integrity check.');
      if (Number.isFinite(Date.parse(chapter.retrievedAt)) && chapter.retrievedAt > modifiedAt) modifiedAt = chapter.retrievedAt;
      const detail = manifest.details?.[link.chapterId];
      if (link.availability === 'removed') body += '<p class="notice">Removed from Royal Road. This is the archived copy.</p>';
      if (detail) {
        if (!keyPattern.test(detail)) throw new Error('Invalid formatted chapter revision.');
        const record = await readJson<ChapterArchive>(join(directory, 'records', `${detail}.json`));
        if (!record || hash(JSON.stringify(record)) !== detail || record.chapter.chapterId !== link.chapterId || record.chapter.contentHash !== chapter.contentHash) throw new Error('Formatted chapter failed its integrity check.');
        if (record.before) body += `<aside><h2>Author’s note</h2>${await render(record.before, record.images, link.url)}</aside>`;
        body += await render(record.html, record.images, link.url);
        if (record.after) body += `<aside><h2>Author’s note</h2>${await render(record.after, record.images, link.url)}</aside>`;
      } else body += chapter.text.split(/\n\s*\n/).map(p => `<p>${xml(p)}</p>`).join('');
    } else body += '<p class="notice">This chapter is unavailable in the archive. It may be locked or removed on Royal Road.</p>';
    add(`OEBPS/${href}`, document(link.title, body));
    chapters.push({ chapterId: link.chapterId, title: link.title, url: link.url, href, contentHash: chapter ? hash(body) : null, availability: link.availability ?? 'available', saved: !!chapter });
  }
  const title = manifest.fiction.title;
  add('OEBPS/nav.xhtml', document(title, `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${chapters.map(c => `<li><a href="${c.href}">${xml(c.title)}</a></li>`).join('')}</ol></nav>`));
  add('OEBPS/toc.ncx', `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:royalroad:${fictionId}"/></head><docTitle><text>${xml(title)}</text></docTitle><navMap>${chapters.map((c, i) => `<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>${xml(c.title)}</text></navLabel><content src="${c.href}"/></navPoint>`).join('')}</navMap></ncx>`);
  add('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:royalroad:${fictionId}</dc:identifier><dc:title>${xml(title)}</dc:title><dc:creator>${xml(manifest.fiction.author ?? 'Unknown')}</dc:creator><dc:language>en</dc:language><dc:source>${xml(manifest.fiction.url)}</dc:source><meta property="dcterms:modified">${new Date(modifiedAt).toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="style.css" media-type="text/css"/>${chapters.map((c, i) => `<item id="chapter-${c.chapterId}" href="${c.href}" media-type="application/xhtml+xml"/>`).join('')}${[...embeddedAssets.entries()].map(([key, a]) => `<item id="i${key}" href="${a.name}" media-type="${a.mime}"${a.cover ? ' properties="cover-image"' : ''}/>`).join('')}</manifest><spine toc="ncx">${chapters.map(c => `<itemref id="${c.chapterId}" idref="chapter-${c.chapterId}"/>`).join('')}</spine></package>`);
  // Embedded mapping lets other readers/importers retain chapter identity too.
  add('META-INF/royal-road.json', JSON.stringify({ fictionId, edition: fingerprint, chapters }));
  const bytes = zipSync(files);
  const edition: Edition = { schemaVersion: 1, fictionId, title, author: manifest.fiction.author ?? '', id: fingerprint, sha256: hash(bytes), bytes: bytes.length, createdAt: modifiedAt, chapters, mediaErrors };
  await mkdir(join(directory, 'editions'), { recursive: true, mode: 0o700 });
  await atomicFile(join(directory, 'editions', `${fingerprint}.epub`), Buffer.from(bytes));
  await atomicJson(join(directory, 'editions', `${fingerprint}.json`), edition);
  await atomicJson(join(directory, 'edition.json'), edition);
  return edition;
}

export async function readEdition(root: string, id: string, edition?: string): Promise<Edition | undefined> {
  if (!idPattern.test(id) || (edition && !keyPattern.test(edition))) throw new Error('Invalid edition.');
  return readJson<Edition>(join(root, id, edition ? `editions/${edition}.json` : 'edition.json'));
}
