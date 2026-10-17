import { request } from 'node:http';
import { z } from 'zod';
import { Store } from './store.js';
import { LibraryQueue } from './library-queue.js';

export const sourceSchema = z.object({ bookId: z.number().int().positive(), title: z.string().max(1000), author: z.string().max(1000),
  selected: z.boolean().optional(),
  files: z.array(z.object({ id: z.number().int().positive(), path: z.string().startsWith('/books/').max(4000), size: z.number().nonnegative() })).max(100) });
export type BookOrbitSource = z.infer<typeof sourceSchema>;
export type AudioSelection = { story: string; title: string; author: string; supported: boolean; reason?: string; source: BookOrbitSource };
export function selections(books: BookOrbitSource[]): AudioSelection[] {
  return books.map(source => {
    const rr = source.files.map(f => /^\/books\/RoyalRoad\/rr-(\d+)\.epub$/.exec(f.path)).find(Boolean);
    const supported = !!rr || source.files.some(f => /\.(epub|pdf)$/i.test(f.path));
    return { story: rr ? `rr-${rr[1]}` : `bo-${source.bookId}`, title: source.title, author: source.author, supported, source,
      ...(!supported ? { reason: 'Choose an EPUB or a PDF with selectable text in BookOrbit' } : {}) };
  });
}
export async function fetchSelection(socketPath: string, path = '/selected'): Promise<BookOrbitSource[]> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'GET' }, res => {
      const parts: Buffer[] = []; let size = 0;
      res.on('data', (part: Buffer) => { size += part.length; if (size > 8_000_000) req.destroy(new Error('Selection too large')); else parts.push(part); });
      res.on('error', reject);
      res.on('end', () => { try { if (res.statusCode !== 200) throw new Error('BookOrbit selection unavailable'); resolve(z.object({ books: z.array(sourceSchema).max(10000) }).parse(JSON.parse(Buffer.concat(parts).toString())).books); } catch (e) { reject(e); } });
    });
    req.setTimeout(30000, () => req.destroy(new Error('BookOrbit selection timed out'))); req.on('error', reject); req.end();
  });
}
export async function reconcileSelection(state: string, queue: LibraryQueue, socket: string, owner: string) {
  if (!/^[a-f0-9]{64}$/.test(owner)) throw new Error('Invalid Listener owner');
  const books = selections(await fetchSelection(socket, '/books'));
  queue.syncBookOrbit(owner, books);
  await new Store(state).write('bookorbit-selection.json', { owner, checkedAt: new Date().toISOString(), books });
}
