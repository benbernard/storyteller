import {hash} from './core.mjs';

// Owner decisions apply only to the exact reviewed text, report and audio.
export function effectiveReview(report, decision) {
 if (!decision) return report;
 if (decision.action !== 'accept' || decision.audioSha256 !== report.sha256 ||
     decision.reportHash !== hash(report) || !decision.reason?.trim() ||
     !decision.ownerInstruction?.trim() || !Number.isFinite(Date.parse(decision.recordedAt)))
  throw Error('Invalid or stale owner review');
 return {...report, automatedSeverity: report.severity, severity: 'minor', ownerReview: decision};
}

export function processingOnlyEntry(config, chapterId, processing, generated, chapter) {
 const entry = config.chapters.find(c => c.chapterId === chapterId);
 if (!entry || processing?.status !== 'needs-review' ||
     generated?.inputHash !== entry.inputHash || hash(chapter) !== entry.inputHash)
  throw Error('Processing-only mode requires a generated chapter already held for review');
 return entry;
}
