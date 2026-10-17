import { z } from 'zod';
import { Store, fingerprint } from './store.js';
import { type Analysis, type Cast, type Chapter, type Position, comparePosition } from './schema.js';
const voiceSchema = z.object({ reference_id: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/), transcript: z.string().min(1), provenance: z.string().min(1), tags: z.array(z.string()), reserved: z.boolean().default(false) }).strict();
export const poolSchema = z.object({ schemaVersion: z.literal(1), model: z.literal('qwen-base'), revision: z.string().regex(/^[a-f0-9]{40}$/), narrator: voiceSchema, anonymous: voiceSchema, voices: z.array(voiceSchema) }).strict();
export type LocalVoice = z.infer<typeof voiceSchema>;
export type LocalPool = z.infer<typeof poolSchema>;
export type LocalAssignment = { id: string; role: string; voice: LocalVoice; from: Position; source: string; evidence: string; reason: string; createdAt: string; parent?: string; correctionOf?: string };
export type LocalCast = { schemaVersion: 1; model: 'qwen-base'; revision: string; assignments: LocalAssignment[] };
export function assignLocal(cast: LocalCast, role: string, voice: LocalVoice, from: Position, source: string, evidence: string, reason: string, correction = false): LocalCast {
  voiceSchema.parse(voice);
  if (!reason.trim() || !evidence.trim()) throw new Error('Casting needs a reason and source evidence');
  const next = structuredClone(cast), previous = next.assignments.filter(a => a.role === role).at(-1);
  if (previous && !correction && comparePosition(from, previous.from) <= 0) throw new Error('A voice change must have a later effective position');
  const decision = { role, voice, from, source, evidence, reason, ...(previous ? { parent: previous.id, ...(correction ? { correctionOf: previous.id } : {}) } : {}) };
  next.assignments.push({ ...decision, id: fingerprint(decision), createdAt: new Date().toISOString() }); return next;
}
export async function saveLocalCast(store: Store, cast: LocalCast) { const key = await store.object('local-cast-history', cast); await store.write('local-cast.json', cast); return key; }
export function localVoiceAt(cast: LocalCast, role: string, at: Position): LocalVoice {
  const superseded = new Set(cast.assignments.filter(a => a.correctionOf && comparePosition(a.from, at) <= 0).map(a => a.correctionOf));
  const choice = [...cast.assignments].reverse().filter(a => a.role === role && !superseded.has(a.id) && comparePosition(a.from, at) <= 0).sort((a, b) => comparePosition(b.from, a.from))[0];
  if (!choice) throw new Error(`No local casting decision for ${role}`); return choice.voice;
}
/** New roles receive a recorded choice once. Existing voices cannot drift with later analysis. */
export function extendLocalCast(saved: LocalCast, roster: Cast, analysis: Analysis, chapter: Chapter, pool: LocalPool) {
  let cast = structuredClone(saved); const metadata = structuredClone(roster);
  if (cast.revision !== pool.revision || cast.model !== pool.model) throw new Error('Local model revision changed; review a new production policy first');
  const used = new Set(cast.assignments.map(a => a.voice.sha256));
  for (const candidate of analysis.characters) {
    if (metadata.members.some(c => c.id === candidate.id)) continue;
    const span = analysis.spans.find(s => s.speaker === candidate.id && s.certainty === 'attributed'); if (!span) throw new Error('Character has no attributed source span');
    metadata.members.push({ id: candidate.id, name: candidate.name, aliases: candidate.aliases.map(name => ({ name, from: { chapter: chapter.sequence, offset: span.start } })), first: { chapter: chapter.sequence, offset: span.start }, evidence: candidate.evidence, portrayal: candidate.portrayal, importance: candidate.importance, voices: [], ...(candidate.continuityFrom ? { continuityFrom: candidate.continuityFrom } : {}) });
  }
  for (const span of analysis.spans) {
    if (cast.assignments.some(a => a.role === span.speaker)) {
      if ((span.speaker === 'anonymous' || span.speaker.startsWith('concealed:')) && !cast.assignments.some(a => a.role === span.speaker && comparePosition(a.from, { chapter: chapter.sequence, offset: span.start }) <= 0)) {
        cast = assignLocal(cast, span.speaker, pool.anonymous, { chapter: chapter.sequence, offset: span.start }, chapter.contentHash, span.text, 'Restore an earlier unresolved or collective speech span', true);
      }
      continue;
    }
    let voice: LocalVoice, reason: string;
    if (span.speaker === 'narrator') { voice = pool.narrator; reason = 'Story narrator policy'; }
    else if (span.speaker === 'anonymous' || span.speaker.startsWith('concealed:')) { voice = pool.anonymous; reason = 'Unresolved or concealed speech; keep identity separate'; }
    else {
      const candidate = analysis.characters.find(c => c.id === span.speaker);
      const member = metadata.members.find(c => c.id === span.speaker); if (!member) throw new Error('No source-grounded character metadata');
      const continuation = candidate?.continuityFrom;
      if (continuation) { voice = localVoiceAt(cast, continuation, { chapter: chapter.sequence, offset: span.start }); reason = 'Preserve the voice of the revealed concealed speaker'; }
      else {
        const tags = candidate?.tags ?? [];
        if (!tags.includes("male") && !tags.includes("female")) throw new Error(`Voice portrayal for ${span.speaker} needs review: missing source-grounded male/female tags`);
        const eligible = pool.voices.filter(v => !v.reserved && v.sha256 !== pool.narrator.sha256 && v.sha256 !== pool.anonymous.sha256
          && ![['male', 'female'], ['female', 'male'], ['adult', 'child'], ['child', 'adult']].some(([a, b]) => tags.includes(a!) && v.tags.includes(b!)));
        const score = (v: LocalVoice) => tags.filter(t => v.tags.includes(t)).length * 10 - (used.has(v.sha256) ? 100 : 0);
        const chosen = eligible.sort((a, b) => score(b) - score(a) || a.sha256.localeCompare(b.sha256))[0];
        if (!chosen) throw new Error(`No compatible local reference for ${span.speaker}; add an auditioned voice to the pool`);
        if (member.importance === 'major' && used.has(chosen.sha256)) throw new Error(`New major character ${span.speaker} needs a distinct auditioned voice`);
        voice = chosen; reason = `Compatible saved reference; tags=${tags.join(',') || 'unspecified'}; reused=${used.has(voice.sha256)}`;
      }
    }
    cast = assignLocal(cast, span.speaker, voice, { chapter: chapter.sequence, offset: span.start }, chapter.contentHash, span.text, reason); used.add(voice.sha256);
  }
  for (const alias of analysis.aliasUpdates) {
    const member = metadata.members.find(c => c.id === alias.characterId); if (!member) throw new Error('Alias target is missing');
    if (!member.aliases.some(a => a.name === alias.name)) member.aliases.push({ name: alias.name, from: { chapter: chapter.sequence, offset: chapter.text.indexOf(alias.evidence) } });
  }
  return { cast, metadata };
}
export function renderCast(cast: LocalCast, analysis: Analysis, chapter: Chapter) {
  const voices: Record<string, LocalVoice> = {};
  for (const span of analysis.spans) {
    const voice = localVoiceAt(cast, span.speaker, { chapter: chapter.sequence, offset: span.start });
    if (voices[span.speaker] && fingerprint(voices[span.speaker]) !== fingerprint(voice)) throw new Error('A mid-chapter recast requires an explicit split render plan');
    voices[span.speaker] = voice;
  }
  return { model: cast.model, revision: cast.revision, voices, castRevision: fingerprint(cast) };
}

/** Reviewed attribution can correct legacy casts without erasing original decisions. */
export function applyFrontierProfiles(saved: LocalCast, roster: Cast, analysis: Analysis, profiles: Analysis['characters'], chapter: Chapter, pool: LocalPool, repair: boolean) {
  let cast = structuredClone(saved); const metadata = structuredClone(roster);
  for (const profile of profiles) {
    const span = analysis.spans.find(s => s.speaker === profile.id && s.certainty === 'attributed'); if (!span) continue;
    const member = metadata.members.find(m => m.id === profile.id);
    if (member) { if (comparePosition({ chapter: chapter.sequence, offset: span.start }, member.first) < 0) member.first = { chapter: chapter.sequence, offset: span.start }; member.name = profile.name; member.portrayal = profile.portrayal; member.evidence = profile.evidence;
      for (const name of profile.aliases) if (!member.aliases.some(a => a.name === name)) member.aliases.push({ name, from: { chapter: chapter.sequence, offset: span.start } });
    }
    const original = [...cast.assignments].reverse().find(a => a.role === profile.id); if (!original) continue;
    const at = { chapter: chapter.sequence, offset: span.start };
    let old: LocalVoice | undefined; try { old = localVoiceAt(cast, profile.id, at); } catch { /* first speech was missed in the legacy analysis */ }
    const incompatible = (voice: LocalVoice) => [['male', 'female'], ['female', 'male'], ['adult', 'child'], ['child', 'adult']].some(([a, b]) => profile.tags.includes(a!) && voice.tags.includes(b!));
    if (old && !incompatible(old)) continue;
    if (!repair) throw new Error(`Existing cast for ${profile.id} conflicts with source evidence; queue a reviewed repair`);
    const uses = (voice: LocalVoice) => cast.assignments.filter(a => a.voice.sha256 === voice.sha256).length;
    const voice = !incompatible(original.voice) ? original.voice : pool.voices.filter(v => !v.reserved && !incompatible(v) && (profile.tags.includes('female') ? v.tags.includes('female') : profile.tags.includes('male') ? v.tags.includes('male') : false))
      .sort((a, b) => uses(a) - uses(b) || profile.tags.filter(t => b.tags.includes(t)).length - profile.tags.filter(t => a.tags.includes(t)).length)[0];
    if (!voice) throw new Error(`No compatible reviewed voice for ${profile.id}`);
    cast = assignLocal(cast, profile.id, voice, at, chapter.contentHash, profile.evidence, 'Repair source-grounded portrayal and first speech after frontier analysis', true);
  }
  return { cast, metadata };
}
