import { z } from 'zod';
import { voiceSchema, type Config, type Segment } from './schema.js';
import { fingerprint } from './store.js';

const text = z.string().min(1).max(2000).refine(value => value.trim().length > 0,
  'Attach whitespace to an adjacent spoken turn');
const tag = z.string().max(100).regex(/^(\[[^\]\r\n]+\]\s*)*$/).default('');
export const auditionSchema = z.union([
  z.object({ voice: voiceSchema, text, model: z.enum(['eleven_v3', 'eleven_multilingual_v2', 'eleven_flash_v2_5']) }).strict(),
  z.object({ model: z.literal('eleven_v3'), turns: z.array(z.object({ voice: voiceSchema, text, tag }).strict()).min(1).max(100) }).strict(),
]);

export function auditionSegment(input: unknown, config: Config): Segment {
  const sample = auditionSchema.parse(input);
  const inputs = 'turns' in sample ? sample.turns : [{ voice: sample.voice, text: sample.text, tag: '' }];
  const rendered = inputs.map(t => ({ voice_id: t.voice.voiceId, text: (t.tag ? t.tag + ' ' : '') + t.text }));
  const characters = rendered.reduce((sum, t) => sum + t.text.length, 0);
  if (characters > 2000) throw new Error('Audition exceeds 2000 characters including delivery tags');
  if (new Set(inputs.map(t => t.voice.voiceId)).size > 10) throw new Error('Audition exceeds 10 voices');
  const request: Record<string, unknown> = { model_id: sample.model, apply_text_normalization: config.policy.normalization };
  if (sample.model === 'eleven_v3') {
    request.inputs = rendered; request.settings = config.policy.dialogueSettings;
  } else {
    request.text = inputs[0]!.text; request.voice_settings = inputs[0]!.voice.settings;
  }
  let offset = 0;
  const turns = inputs.map((t, index) => {
    const start = offset; offset += t.text.length;
    return { spanId: `audition-${index}`, start, end: offset, text: t.text, tag: t.tag, dictionary: [],
      voice: { ...t.voice, version: fingerprint(t.voice), from: { chapter: 1, offset: start }, reason: 'Audition', provenance: 'candidate' } };
  });
  // Preserve existing single-voice cache keys. Scene identities include every
  // voice and request field, so changing one actor invalidates the scene take.
  const identity = 'turns' in sample ? { voices: inputs.map(t => t.voice) } : { voice: sample.voice };
  return { uid: 'audition', fingerprint: fingerprint({ request, ...identity, format: 'mp3_44100_128' }),
    model: sample.model, characters, request, turns };
}
