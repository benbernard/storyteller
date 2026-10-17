import type { Analysis, Cast, Chapter, Config, Correction, Segment, Turn } from './schema.js';
import { voiceAt } from './analysis.js';
import { fingerprint } from './store.js';

function cut(text: string, maximum: number): number {
  if (text.length <= maximum) return text.length;
  const prefix = text.slice(0, maximum);
  const sentences = [...prefix.matchAll(/[.!?][”"’']?\s+|\n\s*\n/gu)];
  const sentence = sentences.at(-1);
  if (sentence && sentence.index! + sentence[0].length > maximum / 3) return sentence.index! + sentence[0].length;
  const whitespace = [...prefix.matchAll(/\s+/gu)].at(-1);
  if (whitespace) return whitespace.index! + whitespace[0].length;
  // Never split a UTF-16 surrogate pair.
  return /[\uD800-\uDBFF]/u.test(prefix.at(-1)!) ? maximum - 1 : maximum;
}

export function plan(chapter: Chapter, analysis: Analysis, cast: Cast, config: Config, corrections: Correction[] = []): Segment[] {
  const policy = config.policy;
  // Bind effective positions to stable spans when an earlier source insertion moves them.
  cast = structuredClone(cast);
  for (const member of cast.members) for (const version of member.voices) {
    const anchor = version.from.chapter === chapter.sequence && version.fromSpanId
      ? analysis.spans.find(s => s.uid === version.fromSpanId) : undefined;
    if (anchor) version.from.offset = anchor.start;
  }
  const allTurns: Turn[] = [];
  const correctionsById = new Map(corrections.map(c => [c.spanId, c]));
  for (const span of analysis.spans) {
    const correction = correctionsById.get(span.uid);
    const speaker = correction?.speaker ?? span.speaker;
    const voice = voiceAt(speaker, chapter.sequence, span.start, cast, config);
    const tag = correction?.tag ?? '';
    if (tag && policy.model !== 'eleven_v3') throw new Error('Delivery tags require a v3 policy');
    if (tag.length + 2 >= policy.maxCharacters) throw new Error('Delivery tag leaves no room for source text');
    // Split source before substitutions, then account for expansions in the final request.
    let consumed = 0;
    const sourceText = correction?.renderText ?? span.text;
    while (consumed < sourceText.length) {
      let length = cut(sourceText.slice(consumed), policy.maxCharacters - tag.length - 1);
      let text = '', dictionary: Config['dictionary'] = [];
      for (;;) {
        if (length <= 0) throw new Error('Cannot split this source token within the request limit');
        const raw = sourceText.slice(consumed, consumed + length);
        dictionary = config.dictionary.filter(d => raw.includes(d.term));
        text = raw;
        for (const entry of dictionary) text = text.split(entry.term).join(entry.spoken);
        if (text.length + tag.length <= policy.maxCharacters) break;
        if (length <= 1) throw new Error('Pronunciation substitution exceeds segment limit');
        length = cut(sourceText.slice(consumed), Math.max(1, Math.floor(length * 0.75)));
      }
      const start = correction?.renderText ? span.start : span.start + consumed;
      const end = correction?.renderText ? span.end : start + length;
      allTurns.push({ spanId: span.uid, start, end, text, voice, dictionary, tag });
      consumed += length;
    }
  }
  const groups: Turn[][] = [];
  let group: Turn[] = [];
  const flush = () => { if (group.length) groups.push(group); group = []; };
  for (const turn of allTurns) {
    const size = group.reduce((n, t) => n + t.text.length + t.tag.length, 0);
    const voices = new Set([...group.map(t => t.voice.voiceId), turn.voice.voiceId]);
    const previous = group.at(-1);
    if (size + turn.text.length + turn.tag.length > policy.maxCharacters || voices.size > 10
      || (policy.model !== 'eleven_v3' && previous && fingerprint(previous.voice) !== fingerprint(turn.voice))
      || policy.grouping === 'turn') flush();
    group.push(turn);
    if ((policy.model !== 'eleven_v3' && /\n\s*\n$/u.test(turn.text)) || /^[\s*=_-]{3,}$/u.test(turn.text)) flush();
  }
  flush();
  const segments: Segment[] = groups.map(turns => {
    const request: Record<string, unknown> = {
      model_id: policy.model, apply_text_normalization: policy.normalization,
      pronunciation_dictionary_locators: config.providerDictionaries,
      ...(policy.seed === null ? {} : { seed: policy.seed }),
    };
    if (policy.model === 'eleven_v3') {
      request.inputs = turns.map(t => ({ text: t.tag + t.text, voice_id: t.voice.voiceId }));
      request.settings = policy.dialogueSettings;
    } else {
      request.text = turns.map(t => t.text).join('');
      request.voice_settings = turns[0]!.voice.settings;
    }
    return { uid: 'segment_' + fingerprint(turns.map(t => ({ spanId: t.spanId, start: t.start, end: t.end, text: t.text }))).slice(0, 32),
      turns, model: policy.model, request, fingerprint: '',
      characters: turns.reduce((n, t) => n + t.text.length + t.tag.length, 0) };
  });
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!, before = segments[i - 1], after = segments[i + 1];
    if (policy.continuity !== 'none') {
      if (before) segment.request.previous_text = before.turns.map(t => t.text).join('').slice(-1000);
      if (after) segment.request.next_text = after.turns.map(t => t.text).join('').slice(0, 1000);
      if (policy.continuity === 'requests' && before && before.turns[0]!.voice.voiceId === segment.turns[0]!.voice.voiceId)
        segment.previousSegment = before.uid;
    }
    // Source locations and arbitrary UIDs do not affect audio. Versions, tags and all actual dependencies do.
    segment.fingerprint = fingerprint({ format: 'mp3_44100_128', adapter: 1, request: segment.request,
      voices: segment.turns.map(t => ({ voiceId: t.voice.voiceId, version: t.voice.version })),
      dictionary: segment.turns.flatMap(t => t.dictionary),
      takes: segment.turns.map(t => correctionsById.get(t.spanId)?.take ?? 0),
      previous: segment.previousSegment ? before?.fingerprint : null });
  }
  return segments;
}
