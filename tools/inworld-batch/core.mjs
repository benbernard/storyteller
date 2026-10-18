import {createHash} from 'node:crypto';
export const sha = data => createHash('sha256').update(data).digest('hex');
export const hash = data => sha(JSON.stringify(data));
export function pack(items, limit = 9500) {
  const batches = []; let group = [], size = 0;
  for (const item of items) {
    const n = item.request.text.length;
    if (!n || n > limit) throw Error('Invalid item size');
    if (size + n > limit && group.length) { batches.push(group); group = []; size = 0; }
    group.push(item); size += n;
  }
  if (group.length) batches.push(group);
  return batches;
}
export function checkResults(items, result) {
  if (!Array.isArray(result.results) || result.results.length !== items.length) throw Error('Incomplete batch results');
  const ids = new Set(items.map(i => i.customId)), seen = new Set();
  for (const row of result.results) {
    if (!ids.has(row.customId) || seen.has(row.customId)) throw Error('Unexpected or duplicate result');
    seen.add(row.customId);
    if (!row.audioUri && !row.error) throw Error('Result has neither audio nor error');
    if (row.audioUri && row.error) throw Error('Conflicting result');
  }
  return result.results;
}
export function assertBudget(jobs, characters, ceiling, usdPerMillion = 20) {
  const spent = jobs.filter(j => j.phase !== 'rejected').reduce((n, j) => n + j.reservedUSD, 0);
  if (spent + characters * usdPerMillion / 1e6 > ceiling) throw Error('Spending ceiling reached');
}
export function validateCoverage(segments, source) {
  let offset = 0;
  for (const segment of segments) {
    if (segment.presentation) { if (segment.spans.length) throw Error('Presentation claims body spans'); continue; }
    for (const span of segment.spans) {
      if (span.start !== offset || span.end < offset || span.end > source.length) throw Error('Invalid source coverage');
      offset = span.end;
    }
    if (segment.spans.map(s => source.slice(s.start, s.end)).join('') !== segment.text) throw Error('Source text differs');
  }
  if (offset !== source.length) throw Error('Incomplete source coverage');
}
