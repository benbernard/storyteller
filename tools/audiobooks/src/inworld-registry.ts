/** Source-grounded character exchange between ordered attribution and direction workers. */
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, rm } from 'node:fs/promises';
import { Store, fingerprint } from './store.js';
import { comparePosition, type Cast, type Chapter, type Analysis } from './schema.js';
import { validateAnalysis } from './analysis.js';
import type { FrontierResult } from './frontier-analysis.js';

export type CharacterEvent = { chapterId: string; sequence: number; source: string; added: string[]; aliases: { characterId: string; name: string }[] };
const nameKey = (name: string) => name.trim().normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
async function recoverDeadWriter(lock: Store): Promise<void> {
  // One reclaimer at a time prevents two readers of an old PID from deleting a
  // new writer's lock. A missing/invalid owner is never evidence of death.
  const reaper = lock.path('recovery.lock');
  try { await mkdir(reaper); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
  try {
    const owner = await lock.read<{ pid?: number }>('writer.lock/owner.json');
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid! <= 0) return;
    try { process.kill(owner.pid!, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') await rm(lock.path('writer.lock'), { recursive: true, force: true });
    }
  } finally { await rm(reaper, { recursive: true, force: true }); }
}
export function historicalCast(cast: Cast, sequence: number): Cast {
  return { schemaVersion: 1, members: cast.members.filter(member => member.first.chapter <= sequence).map(member => ({
    ...structuredClone(member), aliases: member.aliases.filter(alias => alias.from.chapter <= sequence),
    voices: member.voices.filter(voice => voice.from.chapter <= sequence),
  })) };
}
async function registryLock<T>(store: Store, action: () => Promise<T>): Promise<T> {
  const lock = new Store(store.path('inworld-character-registry'));
  for (let attempt = 0; ; attempt++) {
    let entered = false;
    try { return await lock.lock(async () => { entered = true; return action(); }); }
    catch (error) {
      if (entered || attempt >= 200 || !(error instanceof Error) || !error.message.startsWith('State is locked.')) throw error;
      await recoverDeadWriter(lock);
      await delay(50);
    }
  }
}
export async function reconcileCharacters(store: Store, chapter: Chapter, result: FrontierResult): Promise<{ result: FrontierResult; event: CharacterEvent }> {
  return registryLock(store, async () => {
    const cast = await store.read<Cast>('cast.json') ?? { schemaVersion: 1, members: [] };
    const historical = historicalCast(cast, chapter.sequence), remap = new Map<string, string>();
    for (const profile of result.profiles) {
      const matching = historical.members.filter(member => [member.name, ...member.aliases.map(alias => alias.name)].some(name => nameKey(name) === nameKey(profile.name)));
      const identities = new Set(matching.map(member => member.id));
      if (identities.size > 1) throw Error('Ambiguous established character name; explicit identity review required');
      const existing = matching[0];
      if (existing) remap.set(profile.id, existing.id);
      else if (cast.members.some(member => member.id === profile.id && nameKey(member.name) !== nameKey(profile.name))) throw Error('Character ID collides with another identity');
    }
    const normalize = (id: string) => remap.get(id) ?? id;
    const profiles = [...new Map(result.profiles.map(profile => [normalize(profile.id), { ...profile, id: normalize(profile.id) }])).values()];
    const characters = [...new Map(result.analysis.characters.map(profile => [normalize(profile.id), { ...profile, id: normalize(profile.id) }])).values()]
      .filter(profile => !historical.members.some(member => member.id === profile.id && member.first.chapter < chapter.sequence));
    const raw = { spans: result.analysis.spans.map(({ uid: _uid, start: _start, end: _end, ...span }) => ({ ...span, speaker: normalize(span.speaker) })),
      characters, aliasUpdates: result.analysis.aliasUpdates.map(alias => ({ ...alias, characterId: normalize(alias.characterId) })), summary: result.analysis.summary };
    const validationCast = { ...historical, members: historical.members.filter(member => !characters.some(profile => profile.id === member.id)) };
    const analysis: Analysis = { ...result.analysis, ...raw, spans: validateAnalysis(raw, chapter, validationCast, result.analysis) };
    const event: CharacterEvent = { chapterId: chapter.chapterId, sequence: chapter.sequence, source: chapter.contentHash, added: [], aliases: [] };
    for (const profile of profiles) {
      const span = analysis.spans.find(item => item.kind === 'dialogue' && item.speaker === profile.id);
      if (!span) continue;
      if (!chapter.text.includes(profile.evidence)) throw Error('Character evidence must occur in the current source');
      const first = { chapter: chapter.sequence, offset: span.start };
      const existing = cast.members.find(member => member.id === profile.id);
      if (existing && comparePosition(first, existing.first) >= 0) continue;
      if (profile.aliases.some(name => !nameKey(chapter.text).includes(nameKey(name)))) throw Error('New character aliases require explicit current source text');
      if (existing) {
        // An earlier source occurrence replaces undated description fields;
        // otherwise moving `first` back would expose a later chapter's facts.
        existing.first = first; existing.evidence = profile.evidence;
        existing.portrayal = profile.portrayal; existing.importance = profile.importance;
        if (profile.continuityFrom) existing.continuityFrom = profile.continuityFrom;
        else delete existing.continuityFrom;
        for (const name of profile.aliases) {
          const alias = existing.aliases.find(item => nameKey(item.name) === nameKey(name));
          if (alias) { if (comparePosition(first, alias.from) < 0) alias.from = first; }
          else existing.aliases.push({ name, from: first });
        }
        continue;
      }
      cast.members.push({ id: profile.id, name: profile.name, aliases: profile.aliases.map(name => ({ name, from: first })), first,
        evidence: profile.evidence, portrayal: profile.portrayal, importance: profile.importance, voices: [],
        ...(profile.continuityFrom ? { continuityFrom: profile.continuityFrom } : {}) });
      event.added.push(profile.id);
    }
    for (const alias of analysis.aliasUpdates) {
      if (!chapter.text.includes(alias.evidence)) throw Error('Alias evidence must occur in the current source');
      const member = cast.members.find(item => item.id === alias.characterId);
      if (!member) throw Error('Alias names an unknown character');
      if (!member.aliases.some(item => nameKey(item.name) === nameKey(alias.name))) {
        member.aliases.push({ name: alias.name, from: { chapter: chapter.sequence, offset: chapter.text.indexOf(alias.evidence) } });
        event.aliases.push({ characterId: alias.characterId, name: alias.name });
      }
    }
    // Journal the intent before the cast, so interruption cannot lose the added
    // identities. Consumers use attribution.json as the completion marker.
    // Replaying never overwrites established voices or historical portrayal.
    const eventPath = `inworld-character-registry/events/${chapter.sequence}-${fingerprint({ source: chapter.contentHash })}.json`;
    const prior = await store.read<CharacterEvent>(eventPath);
    const saved = prior ?? event;
    await store.write(eventPath, saved);
    await store.write('cast.json', cast);
    return { result: { analysis, profiles }, event: saved };
  });
}
