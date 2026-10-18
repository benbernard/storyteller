import { z } from 'zod';

export const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const position = z.object({ chapter: z.number().int().positive(), offset: z.number().int().nonnegative() }).strict();
export type Position = z.infer<typeof position>;
export const chapterSchema = z.object({
  schemaVersion: z.literal(1), fictionId: id, chapterId: id, sequence: z.number().int().positive(),
  url: z.url(), title: z.string(), text: z.string().min(1).max(500_000),
  retrievedAt: z.iso.datetime(), contentHash: hash,
}).strict();
export type Chapter = z.infer<typeof chapterSchema>;
export const voiceSchema = z.object({
  voiceId: id, settings: z.object({ stability: z.number().min(0).max(1),
    similarity_boost: z.number().min(0).max(1), style: z.number().min(0).max(1).default(0),
    use_speaker_boost: z.boolean().default(true), speed: z.number().min(0.7).max(1.2).default(1) }).strict(),
}).strict();
export type Voice = z.infer<typeof voiceSchema>;
export const policySchema = z.object({
  version: id, model: z.enum(['eleven_v3', 'eleven_flash_v2_5', 'eleven_multilingual_v2', 'inworld-tts-2', 'inworld-tts-2-flash']).default('eleven_v3'),
  maxCharacters: z.number().int().min(80).max(10_000), grouping: z.enum(['scene', 'turn']),
  continuity: z.enum(['none', 'text', 'requests']),
  dialogueSettings: z.object({ stability: z.number().min(0).max(1), similarity: z.number().min(0).max(1) }).strict(),
  normalization: z.enum(['auto', 'on', 'off']), seed: z.number().int().min(0).max(4294967295).nullable(),
  joinPauseMs: z.number().int().min(0).max(3000), selectedAfterListening: z.boolean(),
  listeningEvidence: z.string(),
}).strict().superRefine((p, ctx) => {
  if (p.model === 'eleven_v3' && (p.maxCharacters > 2000 || p.continuity !== 'none'))
    ctx.addIssue({ code: 'custom', message: 'v3 requires <=2000 characters and continuity=none' });
  if (p.model.startsWith('inworld-') && (p.maxCharacters > 2000 || p.continuity === 'requests'))
    ctx.addIssue({ code: 'custom', message: 'Inworld requires <=2000 UTF-16 code units and none/text continuity' });
  if (p.selectedAfterListening && !p.listeningEvidence.trim())
    ctx.addIssue({ code: 'custom', message: 'Selected policy needs listening evidence' });
});
export type Policy = z.infer<typeof policySchema>;
export const configSchema = z.object({
  schemaVersion: z.literal(1), fictionId: id, narrator: voiceSchema, anonymous: voiceSchema,
  protagonistId: id.nullable(), protagonistUsesNarrator: z.boolean(), narrationRules: z.string(),
  pool: z.array(voiceSchema.extend({ tags: z.array(z.string()), rating: z.number().min(0).max(5),
    reserveForMajor: z.boolean(), sampleAsset: hash, ratedBy: z.string().min(1), notes: z.string().min(1) })),
  policy: policySchema,
  analysis: z.object({ model: z.string().min(1), promptVersion: id,
    maxAttempts: z.number().int().min(1).max(4), maxOutputTokens: z.number().int().min(1000).max(100_000),
    maxCallsPerBatch: z.number().int().nonnegative(), usdPerMillionInputTokens: z.number().nonnegative(),
    usdPerMillionOutputTokens: z.number().nonnegative() }).strict(),
  budget: z.object({ maxCharacters: z.number().int().nonnegative(), maxEstimatedUsd: z.number().nonnegative(),
    usdPerThousandCharacters: z.number().nonnegative(), maxAttemptsPerSegment: z.number().int().min(1).max(5) }).strict(),
  dictionary: z.array(z.object({ term: z.string().min(1), spoken: z.string().min(1), version: id }).strict()),
  providerDictionaries: z.array(z.object({ pronunciation_dictionary_id: id, version_id: id }).strict()).max(3),
}).strict().superRefine((c, ctx) => {
  if (c.narrator.voiceId === c.anonymous.voiceId)
    ctx.addIssue({ code: 'custom', message: 'Anonymous voice must differ from narrator' });
  if (new Set(c.pool.map(v => v.voiceId)).size !== c.pool.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate pool voice' });
  if (new Set(c.dictionary.map(d => d.term)).size !== c.dictionary.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate pronunciation term' });
  if (c.budget.maxEstimatedUsd > 0 && c.budget.usdPerThousandCharacters <= 0)
    ctx.addIssue({ code: 'custom', message: 'Paid rendering requires a verified positive character price' });
  if (c.analysis.maxCallsPerBatch > 0 && (c.analysis.usdPerMillionInputTokens <= 0 || c.analysis.usdPerMillionOutputTokens <= 0))
    ctx.addIssue({ code: 'custom', message: 'Paid analysis requires verified positive input and output token prices' });
});
export type Config = z.infer<typeof configSchema>;
export const candidateSchema = z.object({
  id, name: z.string().min(1), aliases: z.array(z.string()), portrayal: z.string(),
  importance: z.enum(['major', 'supporting', 'minor']), tags: z.array(z.string()), evidence: z.string().min(1),
  continuityFrom: z.string().nullable(),
}).strict();
export const analysisSchema = z.object({
  characters: z.array(candidateSchema),
  aliasUpdates: z.array(z.object({ characterId: id, name: z.string().min(1), evidence: z.string().min(1) }).strict()),
  spans: z.array(z.object({ text: z.string().min(1),
    kind: z.enum(['prose', 'dialogue', 'quotation', 'thought', 'system']),
    speaker: z.string().min(1), certainty: z.enum(['attributed', 'uncertain', 'concealed']),
    confidence: z.number().min(0).max(1), reason: z.string(),
  }).strict()).min(1),
  summary: z.string().max(8000),
}).strict();
export type RawAnalysis = z.infer<typeof analysisSchema>;
export type Span = RawAnalysis['spans'][number] & { uid: string; start: number; end: number };
export type Analysis = { schemaVersion: 1; source: string; fingerprint: string; model: string;
  promptVersion: string; spans: Span[]; characters: RawAnalysis['characters']; aliasUpdates: RawAnalysis['aliasUpdates']; summary: string };
export type VoiceVersion = Voice & { version: string; from: Position; fromSpanId?: string; reason: string; provenance: string };
export type CastMember = { id: string; name: string; aliases: { name: string; from: Position }[];
  first: Position; evidence: string; portrayal: string; importance: string; voices: VoiceVersion[]; continuityFrom?: string };
export type Cast = { schemaVersion: 1; members: CastMember[] };
export type Turn = { spanId: string; start: number; end: number; text: string; voice: VoiceVersion;
  dictionary: Config['dictionary']; tag: string };
export type Segment = { uid: string; turns: Turn[]; model: Policy['model']; request: Record<string, unknown>;
  fingerprint: string; characters: number; previousSegment?: string };
export type Asset = { schemaVersion: 1; fingerprint: string; checksum: string; duration: number;
  frames: number; requestId: string | null; generatedAt: string; billedCredits: number | null;
  request: Record<string, unknown>; model: string; characters: number };
export type TimelineEntry = { segmentId: string; asset: string; start: number; end: number;
  spans: { uid: string; start: number; end: number }[]; presentation?: { kind: string; text: string; speaker: string } };
export type Assembly = { schemaVersion: 1; id: string; chapterId: string; sequence: number; source: string;
  analysis: string; plan: string; checksum: string; duration: number; timeline: TimelineEntry[] };
export const correctionSchema = z.object({ spanId: id, speaker: z.string().optional(),
  renderText: z.string().min(1).optional(), tag: z.string().max(100).optional(), reason: z.string().min(1),
  take: z.number().int().nonnegative().default(0) }).strict();
export type Correction = z.infer<typeof correctionSchema>;
export const comparePosition = (a: Position, b: Position) => a.chapter - b.chapter || a.offset - b.offset;
