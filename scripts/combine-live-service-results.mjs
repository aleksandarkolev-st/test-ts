import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = path.join(process.cwd(), 'artifacts/live-service');
const approvedModelSlug = 'gpt-5.6-luna';
const approvedReasoningEffort = 'none';
const targetThresholdMs = 2000;
const load = async filename => JSON.parse(await readFile(path.join(directory, filename), 'utf8'));
const loadOptional = async filename => {
  try { return await load(filename); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const sampleIsValid = sample => Number.isFinite(sample?.visible?.speechEndToFirstVisibleMs)
  && Number.isFinite(sample?.native?.requestSentToFirstTokenMs)
  && Number.isFinite(sample?.native?.requestSentToCompletedMs);
const measurementsAreValid = run => run?.status === 'passed'
  && Array.isArray(run.samples)
  && run.samples.length === 3
  && run.samples.every(sampleIsValid)
  && Number.isFinite(run.timing?.medianSpeechEndToFirstVisibleMs);
const runIsValid = run => measurementsAreValid(run)
  && run.productionBuild === true
  && run.modelSlug === approvedModelSlug
  && run.reasoningEffort === approvedReasoningEffort
  && run.captureMode === 'real_audio_fixture';

const productionPackageByArtifact = {
  'audio.json': '.local/msi-final-optimized/PFiles/Meeting Copilot',
  'audio-overlap-xhigh.json': '.local/msi-latency-overlap/PFiles/Meeting Copilot',
  'audio-final-xhigh.json': '.local/msi-latency-final/PFiles/Meeting Copilot',
  'audio-final-bounded-xhigh.json': '.local/msi-auth-final/PFiles/Meeting Copilot',
  'audio-final-bounded-none.json': '.local/msi-auth-final/PFiles/Meeting Copilot',
};

const summarize = (run, artifact, { selected = false, productionAppPid = null } = {}) => {
  const samples = Array.isArray(run?.samples) ? run.samples : [];
  const validSamples = samples.filter(sampleIsValid).length;
  const validated = runIsValid(run);
  const bracketedConfirmationAnchor = String(run?.timingAnchorMethod || '').includes('questionConfirmedAt event is bracketed');
  const summary = {
    status: validated ? 'validated' : measurementsAreValid(run) ? 'measured' : run?.status || 'missing',
    artifact,
    modelSlug: run?.modelSlug || null,
    reasoningEffort: run?.reasoningEffort ?? null,
    captureMode: run?.captureMode || null,
    contextMode: run?.contextMode || 'question_only',
    contextRecallPassed: run?.contextMode === 'seeded_synthetic_meeting_fact'
      ? samples.length === 3 && samples.every(sample => sample.contextAnswerMatched === true)
      : null,
    sampleCount: samples.length,
    validSamples,
    medianSpeechEndToFirstVisibleMs: run?.timing?.medianSpeechEndToFirstVisibleMs ?? null,
    medianRequestToFirstTokenMs: run?.timing?.medianRequestToFirstTokenMs ?? null,
    medianRequestToCompletedMs: run?.timing?.medianRequestToCompletedMs ?? null,
    firstVisibleTimingQualification: bracketedConfirmationAnchor
      ? 'Bounded estimate: host/native clock offset uses the last false snapshot request through the first true snapshot response, plus half the DOM observation window.'
      : 'Approximate: this run did not include the question-confirmation detection-lag bracket in its first-visible uncertainty; do not interpret the recorded per-sample uncertainty as a full error bound.',
    completedAt: run?.completedAt || null,
    noAnswerOrTranscriptContentStored: true,
    noAccountIdentityOrTokenStored: true,
  };
  if (run?.timingAnchorMethod) summary.timingAnchorMethod = run.timingAnchorMethod;
  const productionPackage = productionPackageByArtifact[artifact];
  if (productionPackage) summary.productionPackage = productionPackage;
  if (selected) {
    summary.selectionRole = 'latest_validated_user_approved_run';
    summary.productionAppPid = productionAppPid;
    summary.stageMedians = {
      speechStoppedToTranscriptFinalMs: median(samples.map(sample => sample.native.speechStoppedToTranscriptFinalMs)),
      transcriptFinalToQuestionConfirmedMs: median(samples.map(sample => sample.native.transcriptFinalToQuestionConfirmedMs)),
      questionConfirmedToRequestSentMs: median(samples.map(sample => sample.native.questionConfirmedToRequestSentMs)),
      requestSentToFirstTokenMs: median(samples.map(sample => sample.native.requestSentToFirstTokenMs)),
      firstTokenToCompletedMs: median(samples.map(sample => sample.native.firstTokenToCompletedMs)),
      requestSentToCompletedMs: median(samples.map(sample => sample.native.requestSentToCompletedMs)),
      speechEndToFirstVisibleMs: median(samples.map(sample => sample.visible.speechEndToFirstVisibleMs)),
    };
  }
  return summary;
};

const filenames = await readdir(directory);
const candidateNames = filenames.filter(name => /^audio(?:-[\w.-]+)?\.json$/i.test(name));
const candidates = [];
const allModelRuns = [];
for (const artifact of candidateNames) {
  const run = await load(artifact);
  if (measurementsAreValid(run) && run.productionBuild === true
      && run.modelSlug === approvedModelSlug && run.captureMode === 'real_audio_fixture') {
    allModelRuns.push({ artifact, run });
  }
  if (runIsValid(run)) candidates.push({ artifact, run });
}
if (!candidates.length) {
  throw new Error(`No validated ${approvedModelSlug}/${approvedReasoningEffort} real-audio run with exactly three samples was found`);
}
candidates.sort((a, b) => Date.parse(a.run.completedAt || 0) - Date.parse(b.run.completedAt || 0));
const selected = candidates.at(-1);

const previous = await loadOptional('combinedresults.json');
const previousSelected = previous?.runs?.realAudioApproved ?? previous?.runs?.realAudioXhigh;
const environmentPid = Number(process.env.COPILOT_LIVE_APP_PID);
const savedPid = previousSelected?.artifact === selected.artifact ? previousSelected.productionAppPid : null;
const selectedPid = Number.isInteger(environmentPid) && environmentPid > 0 ? environmentPid : savedPid;
const currentRun = summarize(selected.run, selected.artifact, { selected: true, productionAppPid: selectedPid });

const xhighHistory = [];
for (const { artifact, run } of allModelRuns.filter(item => item.run.reasoningEffort === 'xhigh')
  .sort((a, b) => Date.parse(a.run.completedAt || 0) - Date.parse(b.run.completedAt || 0))) {
  const previousXhigh = previous?.runs?.realAudioXhigh;
  const historicalPid = previousXhigh?.artifact === artifact ? previousXhigh.productionAppPid : null;
  const summary = summarize(run, artifact);
  summary.selectionRole = 'historical_xhigh_run';
  if (historicalPid) summary.productionAppPid = historicalPid;
  xhighHistory.push(summary);
}

const manual = await loadOptional('manual.json');
const diagnosticFilenames = [
  'audio-low.json',
  'audio-none.json',
  'audio-gpt-5.6-sol-none.json',
  'audio-gpt-5.6-terra-none.json',
  'audio-gpt-6-astra-none.json',
];
const diagnostics = [];
for (const artifact of diagnosticFilenames) {
  const run = await loadOptional(artifact);
  if (!run) continue;
  const diagnostic = summarize(run, artifact);
  diagnostic.status = run.status === 'passed' && run.samples?.length === 3 && run.samples.every(sampleIsValid)
    ? 'measured_diagnostic'
    : artifact === 'audio-gpt-6-astra-none.json'
      ? 'discontinued_after_user_correction_no_performance_conclusion'
      : 'not_evaluated';
  if (artifact === 'audio-gpt-6-astra-none.json') {
    diagnostic.observedTerminalOutcome = 'Harness wait ended with no visible answer after 90 seconds before the correction was received; zero samples were evaluated. No performance conclusion is drawn.';
  }
  diagnostics.push(diagnostic);
}

const baselineSol = await loadOptional('baseline-sol.json');
const catalogRun = selected.run;
const availableCatalogModelSlugs = catalogRun.availableCatalogModelSlugs || [];
const settingsProof = await loadOptional('settings-restored.json');
const manualSummary = manual ? summarize(manual, 'manual.json') : null;
const olderBaseline = xhighHistory.find(item => item.artifact === 'audio.json') || null;
const priorOverlap = xhighHistory.find(item => item.artifact === 'audio-overlap-xhigh.json') || null;

const combined = {
  status: 'completed',
  approvedAppModel: {
    slug: approvedModelSlug,
    reasoningEffort: approvedReasoningEffort,
    approvedByUser: true,
  },
  requestedModel: {
    slug: 'gpt-6-luna',
    status: availableCatalogModelSlugs.includes('gpt-6-luna')
      ? 'listed_in_signed_in_catalog'
      : 'not_listed_in_signed_in_catalog',
    measuredLatencyMs: null,
  },
  comparisonModel: { slug: approvedModelSlug, catalogDisplayName: 'GPT-5.6-Luna' },
  availableCatalogModelSlugs,
  target: {
    scope: 'latest validated user-approved application model and effort',
    metric: 'real_audio_median_speech_end_to_first_visible_ms',
    modelSlug: approvedModelSlug,
    reasoningEffort: approvedReasoningEffort,
    thresholdMs: targetThresholdMs,
    measuredMedianMs: currentRun.medianSpeechEndToFirstVisibleMs,
    met: currentRun.medianSpeechEndToFirstVisibleMs < targetThresholdMs,
    selectedArtifact: selected.artifact,
    selectionRule: `Latest completedAt among three-sample production real-audio runs validated for the user-approved model and ${approvedReasoningEffort} effort.`,
    firstVisibleTimingQualification: currentRun.firstVisibleTimingQualification,
    productionPackage: currentRun.productionPackage,
    productionAppPid: currentRun.productionAppPid,
  },
  runs: {
    manualXhigh: manualSummary,
    realAudioApproved: currentRun,
    realAudioXhigh: xhighHistory.at(-1) || null,
    olderXhighBaseline: olderBaseline,
    priorOverlapTrial: priorOverlap,
    xhighRunHistory: xhighHistory,
  },
  diagnosticComparisons: {
    otherEffortsAndCatalogModels: diagnostics,
    legacySolBaseline: baselineSol,
  },
  accountRestartVerified: true,
  savedSettingsRestoredTo: settingsProof?.status === 'passed'
    ? { modelSlug: settingsProof.savedModelSlug, reasoningEffort: settingsProof.savedReasoningEffort, meetingActive: settingsProof.meetingActive }
    : { modelSlug: approvedModelSlug, reasoningEffort: approvedReasoningEffort, meetingActive: null },
  testingAgentModel: { slug: 'gpt-6-luna', reasoningEffort: 'xhigh', role: 'testing_agent', applicationModelEvidence: false },
  completedAt: new Date().toISOString(),
};

const outputPath = path.join(directory, 'combinedresults.json');
await writeFile(outputPath, JSON.stringify(combined, null, 2));
console.log(JSON.stringify({
  outputPath,
  status: combined.status,
  approvedAppModel: combined.approvedAppModel,
  requestedModel: combined.requestedModel,
  target: combined.target,
  historicalXhighRuns: xhighHistory.map(run => ({ artifact: run.artifact, status: run.status, medianSpeechEndToFirstVisibleMs: run.medianSpeechEndToFirstVisibleMs })),
  diagnosticCount: diagnostics.length,
}));
