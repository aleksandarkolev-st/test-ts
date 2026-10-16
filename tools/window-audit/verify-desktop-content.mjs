import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBitmap } from './verify-report.mjs';

const methods = ['gdi_monitor', 'desktop_duplication', 'wgc_monitor', 'wgc_window'];
const monitorMethods = methods.slice(0, 3);
const slots = [['hiddenBefore', 'hidden_before', false], ['shown', 'shown_overlay', true], ['hiddenAfter', 'hidden_after', false]];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const handle = value => { assert(/^0x[0-9a-f]+$/i.test(value), `Invalid HWND: ${value}`); return BigInt(value).toString(16); };
const sameHandle = (left, right) => handle(left) === handle(right);
const sameRect = (left, right) => !!left && !!right && ['left', 'top', 'right', 'bottom'].every(key => left[key] === right[key]);
const normalizedPath = value => String(value).replaceAll('\\', '/').toLowerCase();
const sameIdentity = (current, initial) => !!current?.exists && !!current.pid && !!current.tid &&
  current.pid === initial.pid && current.tid === initial.tid && sameHandle(current.hwnd, initial.hwnd);
const sameState = (before, after) => sameIdentity(after, before) && sameRect(before.bounds, after.bounds) &&
  before.visible === after.visible && before.topmost === after.topmost &&
  before.affinity.querySucceeded === after.affinity.querySucceeded &&
  (!before.affinity.querySucceeded || before.affinity.value === after.affinity.value);

export function measureDesktopImage(image) {
  assert(image.width > 0 && image.height > 0 && image.rgb.length === image.width * image.height * 3);
  let nearBlack = 0, exactBlack = 0, sentinel = 0, hash = 14695981039346656037n;
  for (let index = 0; index < image.rgb.length; index += 3) {
    const r = image.rgb[index], g = image.rgb[index + 1], b = image.rgb[index + 2];
    if (r <= 6 && g <= 6 && b <= 6) ++nearBlack;
    if (r === 0 && g === 0 && b === 0) ++exactBlack;
    if (r === 0xa5 && g === 0xa5 && b === 0xa5) ++sentinel;
    for (const component of [r, g, b]) hash = BigInt.asUintN(64, (hash ^ BigInt(component)) * 1099511628211n);
  }
  const pixelCount = image.width * image.height;
  return { pixelCount, nearBlackPixelCount: nearBlack, exactBlackPixelCount: exactBlack,
    nearBlackFraction: nearBlack / pixelCount, exactBlackFraction: exactBlack / pixelCount,
    unpaintedFraction: sentinel / pixelCount, rgbFnv1a64: `0x${hash.toString(16).toUpperCase()}`,
    rgbSha256: sha256(image.rgb) };
}

export function compareDesktopImages(reference, candidate) {
  assert.equal(reference.width, candidate.width); assert.equal(reference.height, candidate.height);
  assert.equal(reference.rgb.length, candidate.rgb.length);
  let changed = 0, channelDelta = 0, maxChannelDelta = 0, addedNearBlack = 0, removedNearBlack = 0;
  let addedExactBlack = 0, removedExactBlack = 0;
  let minX = reference.width, minY = reference.height, maxX = -1, maxY = -1;
  let blackMinX = reference.width, blackMinY = reference.height, blackMaxX = -1, blackMaxY = -1;
  const nearBlack = (bytes, index) => bytes[index] <= 6 && bytes[index + 1] <= 6 && bytes[index + 2] <= 6;
  const exactBlack = (bytes, index) => bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 0;
  for (let index = 0; index < reference.rgb.length; index += 3) {
    let different = false;
    for (let channel = 0; channel < 3; ++channel) {
      const delta = Math.abs(reference.rgb[index + channel] - candidate.rgb[index + channel]);
      channelDelta += delta; maxChannelDelta = Math.max(maxChannelDelta, delta); different ||= delta !== 0;
    }
    const pixel = index / 3, x = pixel % reference.width, y = Math.floor(pixel / reference.width);
    if (different) { ++changed; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    const referenceNearBlack = nearBlack(reference.rgb, index), candidateNearBlack = nearBlack(candidate.rgb, index);
    if (!referenceNearBlack && candidateNearBlack) {
      ++addedNearBlack; blackMinX = Math.min(blackMinX, x); blackMinY = Math.min(blackMinY, y);
      blackMaxX = Math.max(blackMaxX, x); blackMaxY = Math.max(blackMaxY, y);
    }
    if (referenceNearBlack && !candidateNearBlack) ++removedNearBlack;
    if (!exactBlack(reference.rgb, index) && exactBlack(candidate.rgb, index)) ++addedExactBlack;
    if (exactBlack(reference.rgb, index) && !exactBlack(candidate.rgb, index)) ++removedExactBlack;
  }
  const pixelCount = reference.width * reference.height;
  return { pixelCount, differingPixelCount: changed, differingPixelFraction: changed / pixelCount,
    exactRgbMatch: changed === 0, meanAbsoluteChannelDelta: channelDelta / reference.rgb.length, maxChannelDelta,
    addedNearBlackPixelCount: addedNearBlack, removedNearBlackPixelCount: removedNearBlack,
    addedExactBlackPixelCount: addedExactBlack, removedExactBlackPixelCount: removedExactBlack,
    differenceBoundsLocal: changed ? { left: minX, top: minY, right: maxX + 1, bottom: maxY + 1 } : null,
    addedNearBlackBoundsLocal: addedNearBlack ? { left: blackMinX, top: blackMinY, right: blackMaxX + 1, bottom: blackMaxY + 1 } : null };
}

export function classifyDesktopTriple(hiddenBefore, shown, hiddenAfter) {
  const hiddenComparison = compareDesktopImages(hiddenBefore, hiddenAfter);
  const shownVsHiddenBefore = compareDesktopImages(hiddenBefore, shown);
  const shownVsHiddenAfter = compareDesktopImages(hiddenAfter, shown);
  return { classification: !hiddenComparison.exactRgbMatch ? 'desktop_changed_inconclusive' :
    shownVsHiddenBefore.exactRgbMatch ? 'exact_background_omission' : 'capture_difference_detected',
    hiddenEndpointsMatch: hiddenComparison.exactRgbMatch, hiddenComparison, shownVsHiddenBefore, shownVsHiddenAfter,
    cleanOmissionObserved: hiddenComparison.exactRgbMatch && shownVsHiddenBefore.exactRgbMatch };
}

function verifyTree(report) {
  assert.equal(report.kind, 'whole-application-window-audit');
  assert.equal(report.rootIdentity.pid, report.rootProcessId);
  const processes = new Map(report.processTree.map(process => [process.pid, process]));
  assert.equal(processes.size, report.processTree.length);
  const root = processes.get(report.rootProcessId); assert(root);
  assert.equal(normalizedPath(root.executablePath), normalizedPath(report.rootIdentity.executablePath));
  assert.equal(Date.parse(root.createdAt), Date.parse(report.rootIdentity.createdAt));
  for (const process of processes.values()) {
    assert(Number.isFinite(Date.parse(process.createdAt)));
    const seen = new Set(); let current = process;
    while (current.pid !== report.rootProcessId) {
      assert(!seen.has(current.pid), 'Process tree cycle'); seen.add(current.pid);
      const parent = processes.get(current.parentPid); assert(parent, `PID ${current.pid} has no application-root ancestry`);
      assert(Date.parse(parent.createdAt) <= Date.parse(current.createdAt), 'Process creation time inversion'); current = parent;
    }
  }
  assert.deepEqual([...report.applicationProcessIds].sort((a, b) => a - b), [...processes.keys()].sort((a, b) => a - b));
  for (const window of report.windows.filter(window => window.isApplicationProcess)) assert(processes.has(window.pid));
  return processes;
}

export async function verifyDesktopContent(directory) {
  directory = path.resolve(directory);
  const evidenceHashes = [], incomplete = [];
  const localPath = filename => {
    assert(typeof filename === 'string' && filename && !path.isAbsolute(filename), 'Evidence paths must be relative');
    const result = path.resolve(directory, filename); assert(result.startsWith(`${directory}${path.sep}`), 'Evidence path escapes run directory'); return result;
  };
  const readBytes = async filename => { const bytes = await readFile(localPath(filename)); evidenceHashes.push({ file: filename, sha256: sha256(bytes) }); return bytes; };
  const readJson = async filename => JSON.parse((await readBytes(filename)).toString('utf8').replace(/^\uFEFF/, ''));
  const manifest = await readJson('manifest.json');
  assert.equal(manifest.schemaVersion, 1);
  assert(Number.isSafeInteger(manifest.rootProcessId) && manifest.rootProcessId > 0);
  handle(manifest.overlayHwnd); handle(manifest.setupHwnd); assert(!sameHandle(manifest.overlayHwnd, manifest.setupHwnd));
  assert(Array.isArray(manifest.windowStates) && Array.isArray(manifest.sets) && manifest.sets.length > 0,
    'Manifest requires windowStates and explicitly linked capture sets');
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
  if (!applicationProvenanceVerified) incomplete.push('Current application binary/build inputs do not match recorded provenance.');
  const states = [], sourceStates = new Map();
  for (const entry of manifest.windowStates) {
    assert(!sourceStates.has(entry.label), 'Duplicate state label');
    const report = await readJson(entry.reportFile), processes = verifyTree(report);
    assert.equal(report.rootProcessId, manifest.rootProcessId);
    assert.equal(normalizedPath(report.rootIdentity.executablePath), normalizedPath(expectedPath));
    const rawFile = path.posix.join(entry.reportFile.replaceAll('\\', '/').split('/').slice(0, -1).join('/'), report.rawSnapshot);
    const raw = await readJson(rawFile); assert.equal(raw.truncated, false); assert.equal(raw.observerPid, report.observerPid);
    assert.equal(raw.windows.length, report.nativeRawWindowCount);
    assert.equal(report.applicationWindowCount, report.windows.filter(window => window.isApplicationProcess).length);
    const overlay = report.windows.find(window => sameHandle(window.hwnd, manifest.overlayHwnd));
    const setup = report.windows.find(window => sameHandle(window.hwnd, manifest.setupHwnd));
    const visibleDiagnosticBackgrounds = raw.windows.filter(window => window.visible &&
      ['WindowAuditRealAppBackdrop', 'WindowAuditFixture'].includes(window.class))
      .map(window => ({ hwnd: window.hwnd, pid: window.pid, class: window.class }));
    for (const window of [overlay, setup].filter(Boolean)) {
      const original = raw.windows.find(item => sameHandle(item.hwnd, window.hwnd));
      assert(original && original.pid === window.pid); assert.deepEqual(original.enumerationSources, window.enumerationSources);
      assert(processes.has(window.pid));
    }
    const result = { label: entry.label, role: entry.role ?? 'context', reportFile: entry.reportFile,
      sampledBefore: report.sampledBefore, sampledAfter: report.sampledAfter, rootProcessId: report.rootProcessId,
      processTreeVerified: true, applicationProcessCount: processes.size, applicationWindowCount: report.applicationWindowCount,
      overlayDiscovered: !!overlay, overlayPid: overlay?.pid ?? null, overlayTid: overlay?.tid ?? null,
      overlayVisible: overlay?.visible ?? null, overlayWindowRect: overlay?.bounds ?? null,
      overlayDiscoverySources: overlay?.enumerationSources ?? [], overlayAffinity: overlay?.affinity ?? null,
      rawTopLevelApplicationWindowCount: report.windows.filter(window => window.isApplicationProcess && window.enumerationSources.includes('EnumWindows')).length,
      visibleNamedTopLevelApplicationWindowCount: report.windows.filter(window => window.isApplicationProcess && window.enumerationSources.includes('EnumWindows') && window.visible && window.title).length,
      setupConfirmedHidden: !!setup && setup.visible === false, visibleDiagnosticBackgrounds };
    states.push(result); sourceStates.set(entry.label, result);
  }
  const captures = [], imageCache = new Map(), sourceCaptures = new Map();
  let attempted = 0, successful = 0, pixels = 0, unavailable = 0, changedTarget = 0;
  const loadCapture = async (entry, role, expectedVisibility) => {
    assert(entry && typeof entry.reportFile === 'string' && typeof entry.windowStateLabel === 'string', 'Every set member requires reportFile and windowStateLabel');
    if (sourceCaptures.has(entry.reportFile)) {
      const cached = sourceCaptures.get(entry.reportFile); assert.equal(cached.role, role, 'Capture report reused for another visibility role'); return cached;
    }
    const report = await readJson(entry.reportFile);
    assert.equal(report.schemaVersion, 1); assert.equal(report.completed, true);
    assert.equal(report.kind, 'real-app-desktop-content-capture');
    assert.equal(report.targetModified, false); assert.equal(report.physicalPanelVisibilityVerified, false);
    assert.equal(report.backgroundWindowCreated, false); assert.equal(report.desktopContentRequiresPairedReferences, true);
    assert(!Object.hasOwn(report, 'phase') && !Object.hasOwn(report, 'referenceOrigin'), 'Desktop-content mode must not use a synthetic background phase');
    assert(sameHandle(report.target.hwnd, manifest.overlayHwnd)); assert.equal(report.target.pid, manifest.rootProcessId);
    assert(report.observerPid > 0 && report.observerPid !== report.target.pid);
    assert.equal(report.target.visible, expectedVisibility, `${entry.reportFile}: wrong actual overlay visibility`);
    assert(sameRect(report.target.bounds, report.region));
    const width = report.region.right - report.region.left, height = report.region.bottom - report.region.top;
    assert(width > 0 && height > 0 && width <= 8192 && height <= 8192);
    assert.deepEqual(report.methods.map(sample => sample.method), methods);
    assert.equal(report.captureAttemptCount, methods.length);
    assert.equal(report.successfulCaptureCount, report.methods.filter(sample => sample.succeeded).length);
    const state = sourceStates.get(entry.windowStateLabel);
    const stateVerified = !!state && state.role === role && state.overlayDiscovered && state.setupConfirmedHidden &&
      state.visibleDiagnosticBackgrounds.length === 0 &&
      state.overlayPid === report.target.pid && state.overlayTid === report.target.tid && state.overlayVisible === expectedVisibility &&
      sameRect(state.overlayWindowRect, report.target.windowRect);
    if (!stateVerified) incomplete.push(`${entry.reportFile}: linked actual overlay/setup/process-tree state is incomplete or mismatched.`);
    const samples = [];
    for (const sample of report.methods) {
      ++attempted;
      const stable = sameState(sample.targetBefore, sample.targetAfter), identity = sameIdentity(sample.targetAfter, report.target);
      assert.equal(sample.targetStateStable, stable); assert.equal(sample.targetIdentityMatchesInitial, identity);
      const targetVerified = stable && identity && sameIdentity(sample.targetBefore, report.target) &&
        sameRect(sample.targetBefore.bounds, report.region) && sameRect(sample.targetAfter.bounds, report.region) &&
        sample.targetBefore.visible === expectedVisibility && sample.targetAfter.visible === expectedVisibility;
      if (!targetVerified) ++changedTarget;
      let imageFile = null, imageHash = null, measurement = null;
      if (sample.succeeded) {
        assert.equal(sample.image, path.basename(sample.image));
        imageFile = path.posix.join(entry.reportFile.replaceAll('\\', '/').split('/').slice(0, -1).join('/'), sample.image);
        const bytes = await readBytes(imageFile), image = decodeBitmap(bytes);
        assert.equal(image.width, width); assert.equal(image.height, height);
        assert.equal(sample.width, width); assert.equal(sample.height, height);
        imageHash = sha256(bytes); measurement = measureDesktopImage(image); ++successful; pixels += measurement.pixelCount;
        assert.equal(sample.measurement.classification, 'uncalibrated_desktop_content');
        assert.equal(sample.measurement.blackPixelsAreNotMaskVerdict, true);
        assert.equal(sample.measurement.pixelHashOrder, 'row-major RGB bytes; alpha excluded');
        for (const key of ['pixelCount', 'exactBlackPixelCount', 'nearBlackPixelCount', 'rgbFnv1a64'])
          assert.equal(sample.measurement[key], measurement[key], `${imageFile}: ${key}`);
        assert(Number.isFinite(sample.measurement.blackFraction) &&
          Math.abs(sample.measurement.blackFraction - measurement.exactBlackFraction) < 1e-7, `${imageFile}: exact-black fraction`);
        assert.equal(sample.classification, stable && identity ? 'uncalibrated_desktop_content' : 'target_state_changed_during_capture');
        imageCache.set(`${entry.reportFile}:${sample.method}`, image);
      } else { ++unavailable; assert.equal(sample.classification, 'capture_unavailable'); assert(!sample.image); }
      samples.push({ method: sample.method, succeeded: sample.succeeded, targetVerified,
        imageFile, bitmapSha256: imageHash, measurement, error: sample.error ?? null });
    }
    const result = { reportFile: entry.reportFile, role, windowStateLabel: entry.windowStateLabel,
      linkedWindowStateVerified: stateVerified, timestamp: report.timestamp, finishedAt: report.finishedAt,
      target: report.target, region: report.region, fullDwmFrameDecoded: true, samples };
    captures.push(result); sourceCaptures.set(entry.reportFile, result); return result;
  };
  const sets = [];
  for (const entry of manifest.sets) {
    const members = {};
    for (const [slot, role, visible] of slots) members[slot] = await loadCapture(entry[slot], role, visible);
    const before = members.hiddenBefore, shown = members.shown, after = members.hiddenAfter;
    const identityAndFrameUnchanged = sameIdentity(shown.target, before.target) && sameIdentity(after.target, before.target) &&
      sameRect(before.region, shown.region) && sameRect(before.region, after.region);
    const sequenceVerified = [before.timestamp, before.finishedAt, shown.timestamp, shown.finishedAt, after.timestamp, after.finishedAt]
      .every(value => Number.isFinite(Date.parse(value))) && Date.parse(before.finishedAt) <= Date.parse(shown.timestamp) &&
      Date.parse(shown.finishedAt) <= Date.parse(after.timestamp);
    const comparisons = [];
    for (const method of methods) {
      const sourceSamples = slots.map(([slot]) => members[slot].samples.find(sample => sample.method === method));
      const result = { method, monitorCapture: monitorMethods.includes(method), classification: 'evidence_incomplete',
        hiddenEndpointsMatch: null, cleanOmissionObserved: false, hiddenComparison: null,
        shownVsHiddenBefore: null, shownVsHiddenAfter: null };
      if (sourceSamples.some(sample => !sample.succeeded)) result.classification = 'capture_unavailable_inconclusive';
      else if (sourceSamples.some(sample => !sample.targetVerified)) result.classification = 'target_changed_inconclusive';
      else if (!identityAndFrameUnchanged) result.classification = 'target_identity_or_frame_changed_inconclusive';
      else if (!sequenceVerified) result.classification = 'capture_sequence_unverified_inconclusive';
      else if (!applicationProvenanceVerified || slots.some(([slot]) => !members[slot].linkedWindowStateVerified)) result.classification = 'application_state_unverified_inconclusive';
      else if (sourceSamples.some(sample => sample.measurement.unpaintedFraction >= 0.98)) result.classification = 'possibly_unpainted_buffer_inconclusive';
      else Object.assign(result, classifyDesktopTriple(...slots.map(([slot]) => imageCache.get(`${members[slot].reportFile}:${method}`))));
      comparisons.push(result);
    }
    const monitorComparisons = comparisons.filter(comparison => comparison.monitorCapture);
    sets.push({ label: entry.label, hiddenBeforeReport: before.reportFile, shownReport: shown.reportFile, hiddenAfterReport: after.reportFile,
      identityAndFrameUnchanged, captureSequenceVerified: sequenceVerified, region: shown.region,
      monitorCaptureRequirementPassed: monitorComparisons.every(comparison => comparison.cleanOmissionObserved),
      monitorResult: monitorComparisons.every(comparison => comparison.cleanOmissionObserved) ? 'exact_background_omission' :
        monitorComparisons.some(comparison => comparison.classification === 'capture_difference_detected') ? 'capture_difference_detected' : 'inconclusive',
      comparisons });
  }
  const monitorComparisons = sets.flatMap(set => set.comparisons).filter(comparison => comparison.monitorCapture);
  const output = { schemaVersion: 1, kind: 'real-app-desktop-content-verification', verifiedAt: new Date().toISOString(),
    targetDescription: 'Actual test-ts Ctrl+Shift+H meeting overlay over ordinary desktop/application content; no diagnostic reference background',
    rootProcessId: manifest.rootProcessId, overlayHwnd: manifest.overlayHwnd, setupHwnd: manifest.setupHwnd,
    applicationProvenanceVerified, currentBinarySha256: binaryHash, currentBuildInputs,
    attemptedCaptureSamples: attempted, successfulCaptureImagesVerified: successful, unavailableCaptures: unavailable,
    rgbPixelsVerified: pixels, capturesWithChangedTarget: changedTarget, captureSetCount: sets.length,
    monitorComparisons: monitorComparisons.length,
    cleanMonitorComparisons: monitorComparisons.filter(comparison => comparison.cleanOmissionObserved).length,
    inconclusiveMonitorComparisons: monitorComparisons.filter(comparison => comparison.classification.endsWith('inconclusive') || comparison.classification === 'evidence_incomplete').length,
    differingMonitorComparisons: monitorComparisons.filter(comparison => comparison.classification === 'capture_difference_detected').length,
    newNearBlackPixelsInStableMonitorComparisons: monitorComparisons.filter(comparison => comparison.hiddenEndpointsMatch === true)
      .reduce((total, comparison) => total + (comparison.shownVsHiddenBefore?.addedNearBlackPixelCount ?? 0), 0),
    monitorCaptureRequirementPassed: sets.length > 0 && sets.every(set => set.monitorCaptureRequirementPassed),
    actualOverlayEnumerable: states.some(state => state.overlayDiscovered && state.overlayDiscoverySources.length > 0),
    hwndInvisibilityRequirementPassed: false, physicalPanelVisibilityVerified: false,
    allLocalSoftwareInvisibilityProven: false, fullOverlayGoalAchieved: false,
    incompleteness: incomplete, windowStates: states, captures, sets, evidenceHashes,
    limitations: ['Every decoded pixel is inside the recorded actual overlay DWM frame; pixels outside that frame and other displays are not checked.',
      'Both hidden endpoint captures must match exactly per method before a shown-frame difference is judged. Changing endpoints make that comparison inconclusive.',
      'Matching endpoint snapshots cannot exclude a transient desktop change occurring only during the shown snapshot.',
      'Natural black desktop pixels are allowed; newly black pixels are counted relative to the actual hidden baseline.',
      'Unavailable direct-window captures do not imply clean monitor omission or black masking.',
      'Window/process snapshots are not atomic and cover the recorded user-mode APIs, not every local observer.',
      'Capture omission cannot establish physical panel visibility or universal invisibility.'] };
  await writeFile(path.join(directory, 'verification.json'), `${JSON.stringify(output, null, 2)}\n`);
  const comparisonRows = sets.flatMap(set => set.comparisons.map(comparison => `<tr><th>${escapeHtml(set.label)}</th><td>${comparison.method}</td><td>${escapeHtml(comparison.classification)}</td><td>${comparison.hiddenEndpointsMatch === null ? 'Unconfirmed' : comparison.hiddenEndpointsMatch ? 'Identical RGB' : 'Changed'}</td><td>${comparison.shownVsHiddenBefore?.differingPixelCount?.toLocaleString('en-US') ?? 'Unconfirmed'}</td><td>${comparison.shownVsHiddenBefore?.addedNearBlackPixelCount?.toLocaleString('en-US') ?? 'Unconfirmed'}</td><td>${comparison.shownVsHiddenBefore?.addedExactBlackPixelCount?.toLocaleString('en-US') ?? 'Unconfirmed'}</td></tr>`)).join('\n');
  const stateRows = states.map(state => `<tr><th>${escapeHtml(state.label)}</th><td>${escapeHtml(state.role)}</td><td>${state.overlayVisible === null ? 'Unconfirmed' : state.overlayVisible ? 'Shown' : 'Hidden'}</td><td>${state.overlayDiscovered ? escapeHtml(state.overlayDiscoverySources.join(', ')) : 'Unconfirmed'}</td><td>${state.visibleNamedTopLevelApplicationWindowCount} visible/titled<br>${state.rawTopLevelApplicationWindowCount} raw top-level</td><td>${state.setupConfirmedHidden ? 'Hidden' : 'Unconfirmed'}</td><td>${state.applicationProcessCount} processes / ${state.applicationWindowCount} windows</td></tr>`).join('\n');
  const previews = sets.slice(0, 1).map(set => `<div class="previews">${[
    ['Overlay hidden before', set.hiddenBeforeReport], ['Actual overlay shown', set.shownReport], ['Overlay hidden after', set.hiddenAfterReport],
  ].map(([label, reportFile]) => {
    const sample = captures.find(capture => capture.reportFile === reportFile)?.samples.find(item => item.method === 'gdi_monitor' && item.succeeded);
    return sample ? `<figure><figcaption>${escapeHtml(label)} — GDI monitor pixels</figcaption><a href="${escapeHtml(sample.imageFile)}"><img src="${escapeHtml(sample.imageFile)}" alt="${escapeHtml(label)} capture of ordinary desktop content"></a></figure>` : '';
  }).join('')}</div>`).join('');
  const status = output.monitorCaptureRequirementPassed ? 'All recorded monitor triples show exact omission over ordinary desktop content.' :
    output.differingMonitorComparisons ? 'At least one stable-endpoint monitor comparison contains a shown-frame difference.' : 'Ordinary-desktop monitor results are inconclusive.';
  await writeFile(path.join(directory, 'summary.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Actual overlay over ordinary desktop content</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:32px;color:#20252b}h1{font-size:26px}table{border-collapse:collapse;font-size:13px;margin:20px 0;width:100%}th,td{border:1px solid #cbd0d5;padding:10px;text-align:left;vertical-align:top}th{background:#f2f4f6}a{color:#245c9c}.result{padding:16px;background:#f2f4f6;border-left:4px solid #596778}.previews{display:flex;gap:16px;flex-wrap:wrap}figure{margin:0;flex:1;min-width:230px}figcaption{font-size:13px;margin-bottom:8px}img{width:100%;height:auto;border:1px solid #cbd0d5}</style>
<h1>Actual Ctrl+Shift+H overlay over ordinary desktop content</h1><p class="result"><strong>${escapeHtml(status)}</strong><br>The actual overlay remains ${output.actualOverlayEnumerable ? 'enumerable in the recorded discovery passes' : 'unconfirmed by the recorded discovery passes'}.</p>
<p>This test uses ordinary desktop/application content behind the actual meeting overlay. It creates no checkerboard or diagnostic reference background. Each set explicitly links hidden-before, shown-overlay, and hidden-after captures of the same HWND, PID, TID and full DWM frame. Setup must be hidden in the linked observed states.</p>
<p>${successful} saved images independently decoded (${pixels.toLocaleString('en-US')} RGB pixels); ${unavailable} / ${attempted} attempts unavailable. Monitor triples: ${output.cleanMonitorComparisons} exact omissions, ${output.differingMonitorComparisons} shown-frame differences, ${output.inconclusiveMonitorComparisons} inconclusive. Newly near-black pixels in stable monitor comparisons: ${output.newNearBlackPixelsInStableMonitorComparisons.toLocaleString('en-US')}.</p>
${previews}
${incomplete.length ? `<p><strong>Incomplete evidence:</strong></p><ul>${incomplete.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
<p>Hidden endpoint images must match exactly before a clean or differing result is assigned. If the desktop changes between the hidden controls, the result is inconclusive. Natural black pixels are permitted. Added near-black pixels (all RGB channels ≤ 6) and added exact-black pixels are measured relative to the actual hidden background; naturally black content is not itself a failure.</p>
<table><tr><th>Set</th><th>Capture API</th><th>Result</th><th>Hidden endpoints</th><th>Changed shown pixels</th><th>Added near-black</th><th>Added exact-black</th></tr>${comparisonRows}</table>
<table><tr><th>Observed state</th><th>Role</th><th>Actual overlay</th><th>Discovery APIs</th><th>EnumWindows app count</th><th>Setup</th><th>Application tree</th></tr>${stateRows}</table>
<p>The visible/titled count is an illustrative filter over raw EnumWindows app results. It does not identify the implementation of any third-party detector.</p>
<p>Coverage is limited to the recorded DWM frame, APIs and capture times. Matching hidden endpoints cannot rule out a transient desktop update only during the shown snapshot. Direct-window failures remain unavailable. Physical panel visibility, invisibility to all local software and the full goal are unproven.</p>
<p><a href="verification.json">Independent verification, pixel differences and evidence hashes</a> · <a href="manifest.json">Run manifest</a></p></html>`);
  console.log(JSON.stringify({ captureSets: sets.length, attempted, images: successful, unavailable,
    cleanMonitorComparisons: output.cleanMonitorComparisons, inconclusiveMonitorComparisons: output.inconclusiveMonitorComparisons,
    differingMonitorComparisons: output.differingMonitorComparisons, monitorCaptureRequirementPassed: output.monitorCaptureRequirementPassed,
    summary: path.join(directory, 'summary.html') }, null, 2));
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node tools/window-audit/verify-desktop-content.mjs RUN_DIR');
  await verifyDesktopContent(process.argv[2]);
}
