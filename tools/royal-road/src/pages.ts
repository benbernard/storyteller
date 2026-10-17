import { load, type CheerioAPI } from 'cheerio';
import { createHash } from 'node:crypto';
import sanitize from 'sanitize-html';

export const origin = 'https://www.royalroad.com';
export const extractorVersion = 2;
export function royalUrl(value: string): URL {
  const url = new URL(value, origin);
  if (url.hostname === 'royalroad.com' && url.protocol === 'https:') url.hostname = 'www.royalroad.com';
  if (url.origin !== origin || url.username || url.password) throw new Error('Expected an HTTPS royalroad.com URL.');
  url.hash = ''; url.search = '';
  return url;
}
export function fictionUrl(value: string): { id: string; url: string } {
  const url = royalUrl(/^\d+$/.test(value) ? `/fiction/${value}` : value);
  const match = /^\/fiction\/(\d+)(?:\/[^/]+)?\/?$/.exec(url.pathname);
  if (!match) throw new Error('Supply a fiction URL or numeric fiction ID.');
  return { id: match[1]!, url: url.href };
}
export interface ChapterLink { chapterId: string; sequence: number; title: string; url: string; availability?: 'available' | 'locked' | 'removed' }
export interface Fiction { fictionId: string; title: string; url: string; chapters: ChapterLink[]; author?: string; description?: string; coverUrl?: string; status?: string }
export interface Chapter { schemaVersion: 1; fictionId: string; chapterId: string; sequence: number; title: string; url: string; text: string; retrievedAt: string; contentHash: string }
export interface ImageRef { url: string; alt: string; section: 'body' | 'before' | 'after' | 'cover'; asset?: string; mime?: string; error?: string }
export interface ChapterArchive { extractorVersion: number; chapter: Chapter; sourceHash: string; html: string; before: string; after: string; images: ImageRef[] }
export const hash = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');
function checkedPage(html: string) {
  const $ = load(html);
  if ($('input[type=password], #challenge-form, #cf-challenge-running').length || /just a moment|access denied/i.test($('title').text())) throw new Error('Royal Road requires sign-in or browser verification. Download stopped.');
  return $;
}
function chapterIdentity(value: string): string {
  const path = royalUrl(value).pathname;
  const match = /^\/fiction\/(?:\d+\/[^/]+\/)?chapter\/(\d+)(?:\/[^/]+)?\/?$/.exec(path);
  if (!match) throw new Error('Unexpected chapter URL.');
  return `rr-${match[1]}`;
}
export function parseFiction(html: string, source: string): Fiction {
  const { id, url } = fictionUrl(source);
  const $ = checkedPage(html);
  let metadata: Record<string, unknown> = {};
  for (const element of $('script[type="application/ld+json"]').toArray()) {
    try {
      const raw: unknown = JSON.parse($(element).text());
      const nodes = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && '@graph' in raw && Array.isArray(raw['@graph']) ? raw['@graph'] : [raw];
      const book = nodes.find(node => node && typeof node === 'object' && typeof node.name === 'string' && node.author);
      if (book) metadata = book;
    } catch { /* Optional metadata must not hide an otherwise valid chapter list. */ }
  }
  const title = typeof metadata.name === 'string' ? metadata.name : $('h1').first().text().trim();
  const chapters: ChapterLink[] = [];
  const seen = new Set<string>();
  const add = (href: string, name: string, unlocked = true) => {
    const chapterId = chapterIdentity(href);
    if (seen.has(chapterId)) throw new Error('Duplicate chapter in the table of contents.');
    seen.add(chapterId);
    chapters.push({ chapterId, sequence: chapters.length + 1, title: name.trim(), url: royalUrl(href).href, availability: unlocked ? 'available' : 'locked' });
  };
  // Parse JSON data only. Never execute scripts supplied by a story page.
  const data = /window\.chapters\s*=\s*(\[[\s\S]*?\])\s*;/.exec(html);
  if (data) {
    const rows: unknown = JSON.parse(data[1]!);
    if (!Array.isArray(rows)) throw new Error('Invalid structured chapter list.');
    for (const row of rows) {
      if (!row || typeof row.url !== 'string' || typeof row.title !== 'string' || typeof row.isUnlocked !== 'boolean') throw new Error('Unsupported structured chapter entry.');
      if (`rr-${row.id}` !== chapterIdentity(row.url)) throw new Error('Structured chapter identity mismatch.');
      add(row.url, row.title, row.isUnlocked);
    }
  } else {
    $('#chapters tbody tr').each((_, row) => { const a = $(row).find('a[href*="/chapter/"]').first(); const href = a.attr('href'); if (href) add(href, a.text()); });
    const count = $('#chapters').attr('data-chapters');
    if (count !== undefined && Number(count) !== chapters.length) throw new Error('Incomplete table of contents.');
  }
  if (!title || (!data && !$('#chapters').length)) throw new Error('No complete table of contents found. The story may be unavailable or the page format has changed.');
  const metadataImage = typeof metadata.image === 'string' ? metadata.image : undefined;
  const cover = metadataImage ?? $('.fic-header img, .cover-art-container img').first().attr('src') ?? $('meta[property="og:image"]').attr('content');
  const author = typeof metadata.author === 'object' && metadata.author !== null && 'name' in metadata.author && typeof metadata.author.name === 'string' ? metadata.author.name : typeof metadata.author === 'string' ? metadata.author : $('meta[property="books:author"]').attr('content') ?? '';
  const status = $('.label, #chapterHeroData span').toArray().map(el=>$(el).text().trim().toUpperCase()).find(text=>['STUB','COMPLETED','ONGOING','HIATUS','DROPPED','INACTIVE'].includes(text));
  return { fictionId: `rr-${id}`, title, url, chapters, author, description: typeof metadata.description === 'string' ? load(metadata.description).text() : $('.description').first().text().trim(), ...(cover ? { coverUrl: new URL(cover, url).href } : {}), ...(status ? {status} : {}) };
}
const allowedTags = ['p','div','span','br','hr','em','strong','b','i','u','s','del','blockquote','pre','code','ul','ol','li','table','thead','tbody','tfoot','tr','td','th','caption','h1','h2','h3','h4','h5','h6','a','img','figure','figcaption','details','summary','sub','sup'];
export function cleanHtml(html: string): string {
  return sanitize(html, { allowedTags, allowedAttributes: { a: ['href','title'], img: ['src','alt'], td: ['colspan','rowspan'], th: ['colspan','rowspan'], details: ['open'] }, allowedSchemes: ['https'], allowProtocolRelative: false,
    transformTags: { a: sanitize.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }) } });
}
function normalizeSpoilers($: CheerioAPI): void {
  $('.spoiler').each((_, el) => {
    const block = $(el);
    const label = block.find('.smalltext').first();
    const text = label.text().trim() || 'Additional text';
    label.remove(); block.find('button,input').remove();
    // Preserve the actual disclosure contents before applying hidden-junk rules.
    block.find('.spoiler-inner').each((_, inner) => { $(inner).replaceWith($(inner).contents()); });
    block.replaceWith($('<details open></details>').append($('<summary></summary>').text(text), block.contents()));
  });
}
export function extractChapter(html: string, fictionId: string, link: ChapterLink): ChapterArchive {
  const $ = checkedPage(html);
  const body = $('.chapter-content');
  if (body.length !== 1) throw new Error('Expected one chapter body; refusing to save an error page.');
  const canonical = $('link[rel=canonical]').attr('href');
  if (canonical && chapterIdentity(canonical) !== link.chapterId) throw new Error('Chapter identity does not match.');
  normalizeSpoilers($);
  const before = body.prevAll('.author-note-portlet').first();
  const after = body.nextAll('.author-note-portlet').first();
  // Some layouts wrap notes in siblings of the chapter's parent.
  const front = before.length ? before : $('.author-note-portlet').filter((_, el) => !!$(el).nextAll().find('.chapter-content').length).last();
  const back = after.length ? after : $('.author-note-portlet').filter((_, el) => !!$(el).prevAll().find('.chapter-content').length).first();
  for (const style of $('style').toArray()) {
    for (const match of $(style).text().matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(match[2]!)) {
        try { body.find(match[1]!.trim()).remove(); } catch { throw new Error('Unsupported hidden-text CSS.'); }
      }
    }
  }
  body.find('script, style, noscript, .author-note, .author-note-portlet, [hidden], [aria-hidden="true"]').remove();
  body.find('[style]').each((_, el) => { if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test($(el).attr('style') ?? '')) $(el).remove(); });
  const images: ImageRef[] = [];
  const fragment = (raw: string, section: ImageRef['section']) => {
    const tree = load(raw, {}, false);
    tree('img').each((_, image) => {
      const el = tree(image);
      const srcset = el.attr('srcset') ?? el.closest('picture').find('source').first().attr('srcset');
      const largest = srcset?.split(',').map(s => s.trim().split(/\s+/)).sort((a,b) => parseFloat(b[1] ?? '0') - parseFloat(a[1] ?? '0'))[0]?.[0];
      const rawSrc = el.attr('data-src') ?? largest ?? el.attr('src');
      if (!rawSrc) { el.replaceWith(tree('<span></span>').text('[Image has no source]')); return; }
      let url: string;
      try { url = new URL(rawSrc, link.url).href; } catch { throw new Error('Invalid image URL.'); }
      const index = images.length;
      images.push({ url, alt: el.attr('alt') ?? '', section });
      el.attr('src', `/pending-image/${index}`);
    });
    return cleanHtml(tree.html());
  };
  const chapterHtml = fragment(body.html() ?? '', 'body');
  const beforeHtml = fragment(front.html() ?? '', 'before');
  const afterHtml = fragment(back.html() ?? '', 'after');
  const textBody = load(chapterHtml, {}, false);
  textBody('img').remove();
  textBody('summary').remove();
  textBody('br').replaceWith('\n'); textBody('hr').replaceWith('\n\n* * *\n\n');
  textBody('td, th').append('\t');
  textBody('p, div, li, tr, blockquote, h1, h2, h3, h4, pre, details, figure').append('\n\n');
  const text = textBody.text().replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text && !images.length) throw new Error('Chapter has no readable content.');
  const narration = text || '[This chapter contains images without text.]';
  if (narration.length > 500_000) throw new Error('Chapter exceeds the audiobook input limit.');
  const chapter: Chapter = { schemaVersion: 1, fictionId, chapterId: link.chapterId, sequence: link.sequence, url: link.url, title: $('h1').first().text().trim() || link.title, text: narration, retrievedAt: new Date().toISOString(), contentHash: hash(narration) };
  return { extractorVersion, chapter, sourceHash: hash(html), html: chapterHtml, before: beforeHtml, after: afterHtml, images };
}
export function parseChapter(html: string, fictionId: string, link: ChapterLink): Chapter { return extractChapter(html, fictionId, link).chapter; }
