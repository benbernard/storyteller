/** A separately versioned composition; legacy renderer policies never change. */
import { fingerprint, sha } from './store.js';
import { renderVisualRedactions, verifyVisualRedactions, type SpokenRedactionRendering } from './spoken-redactions.js';
import { renderCombiningOverlays, verifyCombiningOverlays, type SpokenOverlayRendering } from './spoken-overlays.js';

export const spokenDisplayPolicy = 'visual-redactions-and-overlays-v1' as const;
export interface SpokenDisplayRendering {
  policy: typeof spokenDisplayPolicy;
  sourceHash: string;
  spokenHash: string;
  text: string;
  stages: [SpokenOverlayRendering, SpokenRedactionRendering];
  fingerprint: string;
}
/** Each stage has a complete UTF16 source→spoken map; adjacent hashes link them. */
export function renderSpokenDisplay(source: string): SpokenDisplayRendering {
  const overlays = renderCombiningOverlays(source), redactions = renderVisualRedactions(overlays.text);
  const content = { policy: spokenDisplayPolicy, sourceHash: sha(source), spokenHash: sha(redactions.text),
    text: redactions.text, stages: [overlays, redactions] as [SpokenOverlayRendering, SpokenRedactionRendering] };
  return { ...content, fingerprint: fingerprint(content) };
}
export function verifySpokenDisplay(source: string, value: unknown): SpokenDisplayRendering {
  const expected = renderSpokenDisplay(source);
  if (fingerprint(value) !== fingerprint(expected)) throw Error('Spoken display rendering differs from the exact source and policies');
  verifyCombiningOverlays(source, expected.stages[0]);
  verifyVisualRedactions(expected.stages[0].text, expected.stages[1]);
  return expected;
}
