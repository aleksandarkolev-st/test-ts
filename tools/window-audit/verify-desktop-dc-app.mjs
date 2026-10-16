import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBitmap } from './verify-report.mjs';
import { measureDesktopImage, classifyDesktopTriple } from './verify-desktop-content.mjs';

const methods = ['gdi_monitor', 'desktop_duplication', 'wgc_monitor'];
const slots = [['hiddenBefore', 'hidden_before', false], ['shown', 'shown_renderer', true], ['hiddenAfter', 'hidden_after', false]];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const normalizedPath = value => String(value).replaceAll('\\', '/').toLowerCase();
const handle = value => { assert(/^0x[0-9a-f]+$/i.test(value), `Invalid HWND: ${value}`); return BigInt(value).toString(16); };
const sameHandle = (left, right) => handle(left) === handle(right);
const sameRect = (left, right) => !!left && !!right && ['left', 'top', 'right', 'bottom'].every(key => left[key] === right[key]);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const validProcess = process => process?.querySucceeded === true && process.running === true &&
  Number.isSafeInteger(process.pid) && process.pid > 0 && typeof process.creationFiletime === 'string' &&
  /^[0-9]+$/.test(process.creationFiletime) && BigInt(process.creationFiletime) > 0n && typeof process.executablePath === 'string';
const sameProcess = (left, right) => validProcess(left) && validProcess(right) && left.pid === right.pid &&
  left.creationFiletime === right.creationFiletime && normalizedPath(left.executablePath) === normalizedPath(right.executablePath);
const createdUnixMs = process => Number((BigInt(process.creationFiletime) - 116444736000000000n) / 10000n);

function verifyTree(report) {
  assert.equal(report.kind, 'whole-application-window-audit');
  assert.equal(report.rootIdentity.pid, report.rootProcessId);
  const tree = new Map(report.processTree.map(process => [process.pid, process]));
  assert.equal(tree.size, report.processTree.length); const root = tree.get(report.rootProcessId); assert(root);
  assert.equal(normalizedPath(root.executablePath), normalizedPath(report.rootIdentity.executablePath));
  assert.equal(Date.parse(root.createdAt), Date.parse(report.rootIdentity.createdAt));
  for (const process of tree.values()) {
    assert(Number.isFinite(Date.parse(process.createdAt))); const seen = new Set(); let current = process;
    while (current.pid !== report.rootProcessId) {
      assert(!seen.has(current.pid), 'Process tree cycle'); seen.add(current.pid);
      const parent = tree.get(current.parentPid); assert(parent, `PID ${current.pid}: no application-root ancestry`);
      assert(Date.parse(parent.createdAt) <= Date.parse(current.createdAt), 'Process creation time inversion'); current = parent;
    }
  }
  assert.deepEqual([...report.applicationProcessIds].sort((a, b) => a - b), [...tree.keys()].sort((a, b) => a - b));
  for (const window of report.windows.filter(window => window.isApplicationProcess)) assert(tree.has(window.pid));
  return tree;
}

export function verifyRendererPair(before, after, expectedVisible, region, applicationPid) {
  for (const diagnostic of [before, after]) {
    assert.equal(diagnostic.schemaVersion, 1); assert.equal(diagnostic.backend, 'desktop_dc_experiment');
    assert.equal(diagnostic.processId, applicationPid);
    assert.equal(diagnostic.nativeRendererCreatesHwnd, false);
    assert.equal(diagnostic.createdWindows, 0);
    assert.equal(diagnostic.protectionSupported, false); assert.equal(diagnostic.manualEntrySupported, false);
    assert.equal(diagnostic.region.coordinateSpace, 'physical_desktop_pixels');
    assert.equal(diagnostic.region.width, diagnostic.region.right - diagnostic.region.left);
    assert.equal(diagnostic.region.height, diagnostic.region.bottom - diagnostic.region.top);
    for (const value of [diagnostic.timestampEpochMillis, diagnostic.state.revision, diagnostic.drawCount, diagnostic.lastStateUpdateUnixMs,
      diagnostic.cleanupRequests, diagnostic.state.questionChars, diagnostic.state.answerChars]) assert(Number.isSafeInteger(value) && value >= 0);
    assert(Array.isArray(diagnostic.errors));
  }
  const stateStable = ['active', 'paused', 'status', 'manual'].every(key => before.state[key] === after.state[key]);
  const revisionMonotonic = after.state.revision >= before.state.revision;
  const regionMatches = sameRect(before.region, region) && sameRect(after.region, region);
  const intendedVisibilityMatches = before.intendedVisible === expectedVisible && after.intendedVisible === expectedVisible;
  const workerHealthy = [before, after].every(diagnostic => diagnostic.workerRunning === true &&
    diagnostic.shutdownRequested === false && diagnostic.errors.length === 0);
  const drawCountMonotonic = after.drawCount >= before.drawCount;
  const drawBehaviorMatches = expectedVisible ? after.drawCount > before.drawCount : after.drawCount === before.drawCount;
  const activeShownState = !expectedVisible || [before, after].every(diagnostic => diagnostic.state.active === true &&
    diagnostic.state.paused === false && diagnostic.state.manual === false && typeof diagnostic.state.status === 'string' && diagnostic.state.status.length > 0);
  const lastDrawRevisionMonotonic = before.lastDrawRevision === null ||
    (Number.isSafeInteger(after.lastDrawRevision) && after.lastDrawRevision >= before.lastDrawRevision);
  const recentShownRevisionDrawn = !expectedVisible || (Number.isSafeInteger(after.lastDrawRevision) &&
    after.lastDrawRevision >= before.state.revision && after.lastDrawRevision <= after.state.revision);
  const verified = stateStable && revisionMonotonic && regionMatches && intendedVisibilityMatches && workerHealthy &&
    drawCountMonotonic && drawBehaviorMatches && activeShownState && lastDrawRevisionMonotonic && recentShownRevisionDrawn;
  return { verified, expectedVisible, stateStable, revisionMonotonic, regionMatches, intendedVisibilityMatches,
    workerHealthy, drawCountMonotonic, drawBehaviorMatches, activeShownState, lastDrawRevisionMonotonic, recentShownRevisionDrawn,
    revisionBefore: before.state.revision, revisionAfter: after.state.revision,
    statusBefore: before.state.status, statusAfter: after.state.status, activeBefore: before.state.active, activeAfter: after.state.active,
    pausedBefore: before.state.paused, pausedAfter: after.state.paused,
    intendedVisibleBefore: before.intendedVisible, intendedVisibleAfter: after.intendedVisible,
    drawCountBefore: before.drawCount, drawCountAfter: after.drawCount,
    lastDrawUnixMsBefore: before.lastDrawUnixMs, lastDrawUnixMsAfter: after.lastDrawUnixMs,
    nativeRendererCreatesHwndReported: false, captureProtectionSupportedReported: false,
    physicalPanelVisibilityVerified: false };
}

export async function verifyDesktopDcApp(directory) {
  directory = path.resolve(directory); const evidenceHashes = [], incomplete = [];
  const localPath = filename => {
    assert(typeof filename === 'string' && filename && !path.isAbsolute(filename), 'Evidence paths must be relative');
    const result = path.resolve(directory, filename); assert(result.startsWith(`${directory}${path.sep}`), 'Evidence path escapes run directory'); return result;
  };
  const readBytes = async filename => { const bytes = await readFile(localPath(filename)); evidenceHashes.push({ file: filename, sha256: sha256(bytes) }); return bytes; };
  const readJson = async filename => JSON.parse((await readBytes(filename)).toString('utf8').replace(/^\uFEFF/, ''));
  const manifest = await readJson('manifest.json'); assert.equal(manifest.schemaVersion, 1);
  assert(Number.isSafeInteger(manifest.rootProcessId) && manifest.rootProcessId > 0);
  assert(Array.isArray(manifest.windowStates) && Array.isArray(manifest.sets) && manifest.sets.length > 0);
  const provenance = await readJson(manifest.applicationProvenanceFile ?? 'application-provenance.json');
  const expectedPath = manifest.expectedExecutablePath ?? provenance.binaryPath;
  const binaryHash = sha256(await readFile(expectedPath));
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), currentBuildInputs = [];
  for (const input of provenance.inputs) {
    const filename = path.resolve(repositoryRoot, input.path); assert(filename.startsWith(`${repositoryRoot}${path.sep}`));
    const hash = sha256(await readFile(filename)); currentBuildInputs.push({ path: input.path, sha256: hash, matchesRecordedBuild: hash === input.sha256 });
  }
  const applicationProvenanceVerified = normalizedPath(expectedPath) === normalizedPath(provenance.binaryPath) &&
    binaryHash === provenance.binarySha256 && binaryHash === provenance.expectedBinarySha256 &&
    currentBuildInputs.length > 0 && currentBuildInputs.every(input => input.matchesRecordedBuild);
  if (!applicationProvenanceVerified) incomplete.push('Actual experimental application binary/source provenance is mismatched.');
  const states = [], stateByLabel = new Map();
  for (const entry of manifest.windowStates) {
    assert(!stateByLabel.has(entry.label), 'Duplicate state label');
    const report = await readJson(entry.reportFile), tree = verifyTree(report);
    assert.equal(report.rootProcessId, manifest.rootProcessId);
    assert.equal(normalizedPath(report.rootIdentity.executablePath), normalizedPath(expectedPath));
    const rawFile = path.posix.join(entry.reportFile.replaceAll('\\', '/').split('/').slice(0, -1).join('/'), report.rawSnapshot);
    const raw = await readJson(rawFile); assert.equal(raw.truncated, false); assert.equal(raw.observerPid, report.observerPid);
    assert.equal(raw.windows.length, report.nativeRawWindowCount);
    const windows = report.windows.filter(window => window.isApplicationProcess);
    assert.equal(windows.length, report.applicationWindowCount);
    const rawTreeWindows = raw.windows.filter(window => tree.has(window.pid));
    assert.equal(rawTreeWindows.length, windows.length, 'Whole-application audit omitted raw app-tree HWNDs');
    for (const window of windows) {
      const original = rawTreeWindows.find(candidate => sameHandle(candidate.hwnd, window.hwnd));
      assert(original && original.pid === window.pid); assert.deepEqual(original.enumerationSources, window.enumerationSources);
    }
    const visibleDiagnosticBackgrounds = raw.windows.filter(window => window.visible &&
      ['WindowAuditRealAppBackdrop', 'WindowAuditFixture'].includes(window.class))
      .map(window => ({ hwnd: window.hwnd, pid: window.pid, class: window.class }));
    const enumerableWindows = windows.filter(window => window.enumerationSources.length > 0);
    const result = { label: entry.label, role: entry.role ?? 'context', reportFile: entry.reportFile,
      sampledBefore: report.sampledBefore, sampledAfter: report.sampledAfter, rootProcessId: report.rootProcessId,
      rootCreatedAt: report.rootIdentity.createdAt, processTreeVerified: true, applicationProcessCount: tree.size,
      applicationWindowCount: windows.length, enumerableApplicationTreeWindowCount: enumerableWindows.length,
      strictHwndAbsenceInRecordedScan: windows.length === 0, visibleDiagnosticBackgrounds,
      windows: windows.map(window => ({ hwnd: window.hwnd, pid: window.pid, tid: window.tid,
        class: window.class, title: window.title, visible: window.visible, parent: window.parent, owner: window.owner,
        root: window.root, enumerationSources: window.enumerationSources })) };
    states.push(result); stateByLabel.set(entry.label, result);
  }
  const captures = [], captureCache = new Map(), imageCache = new Map();
  let attempted = 0, successful = 0, unavailable = 0, pixels = 0, identityChanges = 0;
  const loadCapture = async (entry, role, visible) => {
    assert(entry && ['reportFile', 'windowStateLabel', 'rendererBeforeFile', 'rendererAfterFile'].every(key => typeof entry[key] === 'string'),
      'Each triple member requires reportFile/windowStateLabel/rendererBeforeFile/rendererAfterFile');
    if (captureCache.has(entry.reportFile)) { const cached = captureCache.get(entry.reportFile); assert.equal(cached.role, role); return cached; }
    const report = await readJson(entry.reportFile);
    assert.equal(report.kind, 'real-app-monitor-region-capture'); assert.equal(report.schemaVersion, 1); assert.equal(report.completed, true);
    assert.equal(report.applicationPid, manifest.rootProcessId); assert(validProcess(report.application));
    assert.equal(report.application.pid, manifest.rootProcessId);
    assert.equal(normalizedPath(report.application.executablePath), normalizedPath(expectedPath));
    assert.equal(report.applicationIdentityVerifiedAtStart, true);
    assert.equal(report.targetWindowRequired, false); assert.equal(report.applicationModified, false);
    assert.equal(report.backgroundWindowCreated, false); assert.equal(report.physicalPanelVisibilityVerified, false);
    assert.equal(report.desktopContentRequiresPairedReferences, true);
    assert(report.observerPid > 0 && report.observerPid !== report.applicationPid);
    assert.deepEqual(report.methods.map(sample => sample.method), methods);
    assert.equal(report.captureAttemptCount, methods.length);
    assert.equal(report.successfulCaptureCount, report.methods.filter(sample => sample.succeeded).length);
    const width = report.region.right - report.region.left, height = report.region.bottom - report.region.top;
    assert(width > 0 && height > 0 && width <= 8192 && height <= 8192);
    const rendererBefore = await readJson(entry.rendererBeforeFile), rendererAfter = await readJson(entry.rendererAfterFile);
    const renderer = verifyRendererPair(rendererBefore, rendererAfter, visible, report.region, manifest.rootProcessId);
    renderer.diagnosticsBracketCapture = rendererBefore.timestampEpochMillis <= Date.parse(report.timestamp) &&
      rendererAfter.timestampEpochMillis >= Date.parse(report.finishedAt);
    renderer.shownDrawAfterCaptureStarted = !visible || rendererAfter.lastDrawUnixMs >= Date.parse(report.timestamp);
    renderer.verified &&= renderer.diagnosticsBracketCapture && renderer.shownDrawAfterCaptureStarted;
    const state = stateByLabel.get(entry.windowStateLabel);
    const stateVerified = !!state && state.role === role && state.processTreeVerified &&
      state.visibleDiagnosticBackgrounds.length === 0 && Date.parse(state.rootCreatedAt) === createdUnixMs(report.application);
    if (!stateVerified) incomplete.push(`${entry.reportFile}: linked whole-tree process instance/state is not verified.`);
    if (!renderer.verified) incomplete.push(`${entry.reportFile}: renderer intent/state/draw progress is not verified.`);
    const samples = [];
    for (const sample of report.methods) {
      ++attempted;
      const stable = sameProcess(sample.applicationBefore, sample.applicationAfter);
      const identity = sameProcess(sample.applicationAfter, report.application);
      assert.equal(sample.applicationStateStable, stable); assert.equal(sample.applicationIdentityMatchesInitial, identity);
      const identityVerified = stable && identity && sameProcess(sample.applicationBefore, report.application);
      if (!identityVerified) ++identityChanges;
      let imageFile = null, imageHash = null, measurement = null;
      if (sample.succeeded) {
        assert.equal(sample.image, path.basename(sample.image));
        imageFile = path.posix.join(entry.reportFile.replaceAll('\\', '/').split('/').slice(0, -1).join('/'), sample.image);
        const bytes = await readBytes(imageFile), image = decodeBitmap(bytes);
        assert.equal(image.width, width); assert.equal(image.height, height); assert.equal(sample.width, width); assert.equal(sample.height, height);
        measurement = measureDesktopImage(image); imageHash = sha256(bytes); ++successful; pixels += measurement.pixelCount;
        assert.equal(sample.measurement.classification, 'uncalibrated_desktop_content');
        assert.equal(sample.measurement.blackPixelsAreNotMaskVerdict, true);
        assert.equal(sample.measurement.pixelHashOrder, 'row-major RGB bytes; alpha excluded');
        for (const key of ['pixelCount', 'exactBlackPixelCount', 'nearBlackPixelCount', 'rgbFnv1a64'])
          assert.equal(sample.measurement[key], measurement[key], `${imageFile}: ${key}`);
        assert(Number.isFinite(sample.measurement.blackFraction) && Math.abs(sample.measurement.blackFraction - measurement.exactBlackFraction) < 1e-7);
        assert.equal(sample.classification, stable && identity ? 'uncalibrated_desktop_content' : 'application_identity_changed_during_capture');
        imageCache.set(`${entry.reportFile}:${sample.method}`, image);
      } else { ++unavailable; assert.equal(sample.classification, 'capture_unavailable'); assert(!sample.image); }
      samples.push({ method: sample.method, succeeded: sample.succeeded, applicationIdentityVerified: identityVerified,
        imageFile, bitmapSha256: imageHash, measurement, error: sample.error ?? null });
    }
    const result = { reportFile: entry.reportFile, role, timestamp: report.timestamp, finishedAt: report.finishedAt,
      region: report.region, application: report.application, applicationAfter: report.applicationAfter,
      applicationIdentityVerifiedAtEnd: sameProcess(report.applicationAfter, report.application),
      windowStateLabel: entry.windowStateLabel, linkedWholeTreeStateVerified: stateVerified,
      rendererBeforeFile: entry.rendererBeforeFile, rendererAfterFile: entry.rendererAfterFile,
      rendererVerification: renderer, fullRegionDecoded: true, samples };
    captures.push(result); captureCache.set(entry.reportFile, result); return result;
  };
  const sets = [];
  for (const entry of manifest.sets) {
    const members = {}; for (const [slot, role, visible] of slots) members[slot] = await loadCapture(entry[slot], role, visible);
    const before = members.hiddenBefore, shown = members.shown, after = members.hiddenAfter;
    const identityAndRegionUnchanged = sameProcess(shown.application, before.application) && sameProcess(after.application, before.application) &&
      sameRect(before.region, shown.region) && sameRect(before.region, after.region);
    const sequenceVerified = [before.timestamp, before.finishedAt, shown.timestamp, shown.finishedAt, after.timestamp, after.finishedAt]
      .every(value => Number.isFinite(Date.parse(value))) && Date.parse(before.finishedAt) <= Date.parse(shown.timestamp) &&
      Date.parse(shown.finishedAt) <= Date.parse(after.timestamp);
    const comparisons = [];
    for (const method of methods) {
      const samples = slots.map(([slot]) => members[slot].samples.find(sample => sample.method === method));
      const comparison = { method, classification: 'evidence_incomplete', hiddenEndpointsMatch: null, cleanOmissionObserved: false,
        hiddenComparison: null, shownVsHiddenBefore: null, shownVsHiddenAfter: null };
      if (samples.some(sample => !sample.succeeded)) comparison.classification = 'capture_unavailable_inconclusive';
      else if (samples.some(sample => !sample.applicationIdentityVerified) || slots.some(([slot]) => !members[slot].applicationIdentityVerifiedAtEnd))
        comparison.classification = 'application_identity_changed_inconclusive';
      else if (!identityAndRegionUnchanged) comparison.classification = 'application_identity_or_region_changed_inconclusive';
      else if (!sequenceVerified) comparison.classification = 'capture_sequence_unverified_inconclusive';
      else if (!applicationProvenanceVerified || slots.some(([slot]) => !members[slot].linkedWholeTreeStateVerified || !members[slot].rendererVerification.verified))
        comparison.classification = 'application_or_renderer_state_unverified_inconclusive';
      else if (samples.some(sample => sample.measurement.unpaintedFraction >= 0.98)) comparison.classification = 'possibly_unpainted_buffer_inconclusive';
      else Object.assign(comparison, classifyDesktopTriple(...slots.map(([slot]) => imageCache.get(`${members[slot].reportFile}:${method}`))));
      comparisons.push(comparison);
    }
    sets.push({ label: entry.label, hiddenBeforeReport: before.reportFile, shownReport: shown.reportFile, hiddenAfterReport: after.reportFile,
      identityAndRegionUnchanged, captureSequenceVerified: sequenceVerified, region: shown.region, comparisons,
      monitorCaptureRequirementPassed: comparisons.every(comparison => comparison.cleanOmissionObserved),
      monitorResult: comparisons.every(comparison => comparison.cleanOmissionObserved) ? 'exact_background_omission' :
        comparisons.some(comparison => comparison.classification === 'capture_difference_detected') ? 'capture_difference_detected' : 'inconclusive' });
  }
  const comparisons = sets.flatMap(set => set.comparisons), usedStates = states.filter(state => captures.some(capture => capture.windowStateLabel === state.label));
  const output = { schemaVersion: 1, kind: 'actual-app-desktop-dc-verification', verifiedAt: new Date().toISOString(),
    targetDescription: 'Actual experimental test-ts Desktop-DC renderer over ordinary desktop content; no target HWND required',
    rootProcessId: manifest.rootProcessId, applicationProvenanceVerified, currentBinarySha256: binaryHash, currentBuildInputs,
    attemptedCaptureSamples: attempted, successfulCaptureImagesVerified: successful, unavailableCaptures: unavailable,
    rgbPixelsVerified: pixels, capturesWithChangedApplicationIdentity: identityChanges, captureSetCount: sets.length,
    cleanMonitorComparisons: comparisons.filter(comparison => comparison.cleanOmissionObserved).length,
    inconclusiveMonitorComparisons: comparisons.filter(comparison => comparison.classification.endsWith('inconclusive') || comparison.classification === 'evidence_incomplete').length,
    differingMonitorComparisons: comparisons.filter(comparison => comparison.classification === 'capture_difference_detected').length,
    newNearBlackPixelsInStableMonitorComparisons: comparisons.filter(comparison => comparison.hiddenEndpointsMatch === true)
      .reduce((sum, comparison) => sum + (comparison.shownVsHiddenBefore?.addedNearBlackPixelCount ?? 0), 0),
    monitorCaptureRequirementPassed: sets.every(set => set.monitorCaptureRequirementPassed),
    strictHwndAbsenceInRecordedWholeTreeScans: usedStates.length > 0 && usedStates.every(state => state.strictHwndAbsenceInRecordedScan),
    enumerableApplicationTreeWindowsObserved: usedStates.some(state => state.enumerableApplicationTreeWindowCount > 0),
    strictGateDoesNotFilterVisibilityTitleOrWindowClass: true,
    rendererCreatesHwndReported: false, captureProtectionSupportedReported: false,
    physicalPanelVisibilityVerified: false, allLocalSoftwareInvisibilityProven: false, fullOverlayGoalAchieved: false,
    incompleteness: incomplete, windowStates: states, captures, sets, evidenceHashes,
    limitations: ['All app-tree HWNDs count against the strict discovery gate, including hidden, untitled, tool, setup, event and message-only helpers.',
      'The renderer reporting no HWND does not prove whole-application HWND absence; raw enumeration and process-tree membership are evaluated independently.',
      'Renderer diagnostics record intended visibility and successful GDI draw operations, not independently observed physical panel pixels.',
      'Revision increases are allowed while active/paused/status/manual state and region remain stable within each diagnostic pair.',
      'Captures cover every decoded pixel inside the requested renderer region, not the entire display.',
      'Different hidden endpoints make capture comparisons inconclusive. Natural black pixels are allowed; added black is measured against the actual hidden baseline.',
      'Matching endpoint snapshots cannot exclude a transient background change occurring only during the shown snapshot.',
      'Native capture and window/process snapshots are not atomic and do not cover all privileged observers.',
      'The experimental Desktop-DC backend reports no capture-protection support. Successful draw calls do not imply capture exclusion.'] };
  await writeFile(path.join(directory, 'verification.json'), `${JSON.stringify(output, null, 2)}\n`);
  const rows = sets.flatMap(set => set.comparisons.map(comparison => `<tr><th>${escapeHtml(set.label)}</th><td>${comparison.method}</td><td>${escapeHtml(comparison.classification)}</td><td>${comparison.hiddenEndpointsMatch === null ? 'Unconfirmed' : comparison.hiddenEndpointsMatch ? 'Identical RGB' : 'Changed'}</td><td>${comparison.shownVsHiddenBefore?.differingPixelCount?.toLocaleString('en-US') ?? 'Unconfirmed'}</td><td>${comparison.shownVsHiddenBefore?.addedNearBlackPixelCount?.toLocaleString('en-US') ?? 'Unconfirmed'}</td></tr>`)).join('\n');
  const stateRows = states.map(state => `<tr><th>${escapeHtml(state.label)}</th><td>${escapeHtml(state.role)}</td><td>${state.applicationProcessCount}</td><td>${state.applicationWindowCount}</td><td>${state.enumerableApplicationTreeWindowCount}</td><td>${state.strictHwndAbsenceInRecordedScan ? 'Absent in this scan' : 'Fails: HWNDs found'}</td></tr>`).join('\n');
  const diagnosticRows = captures.map(capture => `<tr><th>${escapeHtml(capture.role)}</th><td>${capture.rendererVerification.verified ? 'Verified pair' : 'Incomplete'}</td><td>${capture.rendererVerification.intendedVisibleBefore} → ${capture.rendererVerification.intendedVisibleAfter}</td><td>${capture.rendererVerification.drawCountBefore} → ${capture.rendererVerification.drawCountAfter}</td><td>${capture.rendererVerification.revisionBefore} → ${capture.rendererVerification.revisionAfter}</td><td>${escapeHtml(capture.rendererVerification.statusBefore)}</td></tr>`).join('\n');
  const previews = sets.flatMap(set => [set.hiddenBeforeReport, set.shownReport, set.hiddenAfterReport].map((file, index) => {
    const capture = captures.find(item => item.reportFile === file), sample = capture.samples.find(item => item.method === 'gdi_monitor');
    if (!sample.imageFile) return '';
    const url = sample.imageFile.split('/').map(encodeURIComponent).join('/');
    return `<figure><figcaption>${['Hidden before', 'Renderer intended shown', 'Hidden after'][index]} — GDI region pixels</figcaption><a href="${url}"><img src="${url}" alt="${escapeHtml(capture.role)} captured desktop region"></a></figure>`;
  })).join('\n');
  const captureStatus = output.monitorCaptureRequirementPassed ? 'Recorded monitor triples show exact background omission.' :
    output.differingMonitorComparisons ? 'The shown renderer changes captured desktop pixels in at least one stable-endpoint comparison.' : 'Capture omission is inconclusive.';
  await writeFile(path.join(directory, 'summary.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Actual app Desktop-DC experiment</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:32px;color:#20252b}h1{font-size:26px}table{border-collapse:collapse;font-size:13px;width:100%;margin:20px 0}th,td{border:1px solid #cbd0d5;padding:10px;text-align:left;vertical-align:top}th{background:#f2f4f6}a{color:#245c9c}.result{background:#f2f4f6;padding:16px;border-left:4px solid #596778}.previews{display:flex;gap:16px;flex-wrap:wrap}figure{flex:1;min-width:230px;margin:0}figcaption{font-size:13px;margin-bottom:8px}img{width:100%;height:auto;border:1px solid #cbd0d5}</style>
<h1>Actual test-ts Desktop-DC experiment</h1><p class="result"><strong>${escapeHtml(captureStatus)}</strong><br>Strict app-tree HWND absence: ${output.strictHwndAbsenceInRecordedWholeTreeScans ? 'no HWNDs observed in these scans; broader absence is unproven' : 'failed or incomplete'}.</p>
<p>This experiment runs the actual application with its experimental Desktop-DC backend. Monitor captures need no target HWND. Independent whole-application scans count <strong>every</strong> app-tree HWND; hidden, untitled and message-only helpers are included. The renderer's own no-HWND claim cannot pass that gate.</p>
<p>${successful} saved images independently decoded (${pixels.toLocaleString('en-US')} RGB pixels); ${unavailable} / ${attempted} attempts unavailable. Comparisons: ${output.cleanMonitorComparisons} exact omissions, ${output.differingMonitorComparisons} shown-frame differences, ${output.inconclusiveMonitorComparisons} inconclusive.</p>
<div class="previews">${previews}</div>
${incomplete.length ? `<p><strong>Incomplete evidence:</strong></p><ul>${incomplete.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
<table><tr><th>Set</th><th>Capture API</th><th>Result</th><th>Hidden endpoints</th><th>Changed shown pixels</th><th>Added near-black pixels</th></tr>${rows}</table>
<p>Both hidden endpoints must match exactly before a shown-frame difference is judged. Changing backgrounds make the comparison inconclusive. Existing black desktop pixels are permitted; newly near-black pixels are measured relative to the actual hidden baseline.</p>
<table><tr><th>Observed state</th><th>Role</th><th>App processes</th><th>All app HWNDs</th><th>Enumerable app HWNDs</th><th>Strict gate</th></tr>${stateRows}</table>
<table><tr><th>Renderer state</th><th>Diagnostic pair</th><th>Intended visible</th><th>Draw count</th><th>Snapshot revision</th><th>Status</th></tr>${diagnosticRows}</table>
<p>The backend reports capture protection unsupported. Native drawing diagnostics establish state and successful GDI operations, not physical panel visibility. Coverage is limited to these regions, times and user-mode APIs. Invisibility to all local software and the full goal remain unproven.</p>
<p><a href="verification.json">Independent verification, differences and evidence hashes</a> · <a href="manifest.json">Run manifest</a></p></html>`);
  console.log(JSON.stringify({ captureSets: sets.length, attempted, images: successful, unavailable,
    cleanMonitorComparisons: output.cleanMonitorComparisons, differingMonitorComparisons: output.differingMonitorComparisons,
    inconclusiveMonitorComparisons: output.inconclusiveMonitorComparisons,
    strictHwndAbsenceInRecordedWholeTreeScans: output.strictHwndAbsenceInRecordedWholeTreeScans,
    monitorCaptureRequirementPassed: output.monitorCaptureRequirementPassed, summary: path.join(directory, 'summary.html') }, null, 2));
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node tools/window-audit/verify-desktop-dc-app.mjs RUN_DIR');
  await verifyDesktopDcApp(process.argv[2]);
}
