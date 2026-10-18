import { bookOrbitUrl } from './integrations.js';
import { readFile, realpath, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';
import { load } from 'cheerio';
import { type BookOrbitSource } from './bookorbit-selection.js';
import { sha } from './store.js';
import { type Chapter } from './schema.js';

const exec = promisify(execFile);
function textOf(html: string) {
  const $ = load(html); $('script,style,nav').remove();
  $('br').replaceWith('\n'); $('p,div,h1,h2,h3,h4,li,blockquote').append('\n\n');
  return $('body').text().replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function epubChapters(bytes: Uint8Array): { key: string; title: string; text: string }[] {
  let expanded = 0;
  const files = unzipSync(bytes, { filter: file => { if (!/\.(xml|opf|html|xhtml|htm)$/i.test(file.name)) return false; expanded += file.originalSize; if (expanded > 100_000_000 || file.originalSize > 20_000_000) throw new Error('EPUB entry too large'); return /\.(xml|opf|html|xhtml|htm)$/i.test(file.name); } });
  if (Object.values(files).reduce((n, f) => n + f.length, 0) > 100_000_000) throw new Error('EPUB text too large');
  if (files['META-INF/encryption.xml'] && /EncryptedData/.test(Buffer.from(files['META-INF/encryption.xml']).toString())) {
    const encryption = load(Buffer.from(files['META-INF/encryption.xml']).toString(), { xml: true });
    const methods = encryption('*').toArray().filter(e => e.type === 'tag' && e.name.split(':').at(-1) === 'EncryptionMethod');
    if (!methods.length || methods.some(e => !['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'].includes(encryption(e).attr('Algorithm') ?? ''))) throw new Error('EPUB text is encrypted');
  }
  const container = files['META-INF/container.xml']; if (!container) throw new Error('EPUB container missing');
  const xml = load(Buffer.from(container).toString(), { xml: true }); const packagePath = xml('rootfile').first().attr('full-path');
  if (!packagePath || !files[packagePath]) throw new Error('EPUB package missing');
  const opf = load(Buffer.from(files[packagePath]).toString(), { xml: true });
  const result = [];
  for (const ref of opf('spine itemref').toArray()) {
    if (opf(ref).attr('linear') === 'no') continue;
    const item = opf('manifest item').toArray().find(e => opf(e).attr('id') === opf(ref).attr('idref'));
    if (!item || (opf(item).attr('properties') ?? '').split(/\s+/).includes('nav')) continue;
    const href = opf(item).attr('href'); if (!href) throw new Error('EPUB spine reference missing');
    const key = posix.normalize(posix.join(posix.dirname(packagePath), decodeURIComponent(href.split('#')[0]!)));
    const data = files[key]; if (!data) throw new Error('EPUB chapter missing');
    const html = Buffer.from(data).toString(); const text = textOf(html); if (!text) continue;
    if (text.length > 500_000) throw new Error('EPUB chapter exceeds supported size');
    const $ = load(html); result.push({ key, title: $('h1,h2,h3').first().text().trim() || $('title').text().trim() || `Chapter ${result.length + 1}`, text });
  }
  if (!result.length) throw new Error('EPUB has no readable chapters');
  return result;
}
export async function bookOrbitChapters(source: BookOrbitSource, story: string): Promise<Chapter[]> {
  const file = [...source.files].sort((a, b) => Number(/\.epub$/i.test(b.path)) - Number(/\.epub$/i.test(a.path)) || b.id - a.id).find(f => /\.(epub|pdf)$/i.test(f.path));
  if (!file || await realpath('/books') !== '/books' || !(await realpath(file.path)).startsWith('/books/')) throw new Error('BookOrbit source is unavailable');
  if ((await stat(file.path)).size > 250_000_000) throw new Error('BookOrbit file exceeds supported size');
  let entries: { key: string; title: string; text: string }[];
  if (/\.epub$/i.test(file.path)) entries = epubChapters(await readFile(file.path));
  else {
    const { stdout } = await exec('pdftotext', ['-layout', file.path, '-'], { maxBuffer: 50_000_000, timeout: 120000 }).catch(() => { throw new Error('PDF text could not be extracted; use an unencrypted PDF with selectable text'); });
    entries = stdout.split('\f').map((text, i) => ({ key: `page-${i + 1}`, title: `Page ${i + 1}`, text: text.trim() })).filter(e => e.text);
    if (!entries.length) throw new Error('This PDF has no selectable text; OCR is required before generation');
  }
  const retrievedAt = new Date().toISOString();
  return entries.map((entry, i) => ({ schemaVersion: 1, fictionId: story, chapterId: `chapter-${sha(entry.key).slice(0, 24)}`, sequence: i + 1,
    url: `${bookOrbitUrl(source.bookId)}#${encodeURIComponent(entry.key)}`, title: entry.title, text: entry.text, contentHash: sha(entry.text), retrievedAt }));
}
