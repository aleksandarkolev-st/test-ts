import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBitmap, measure } from './verify-report.mjs';

const captureMethods = ['gdi_monitor', 'desktop_duplication', 'wgc_monitor', 'wgc_window'];
const monitorMethods = captureMethods.slice(0, 3);
const roles = ['hidden_control', 'shown_overlay', 'reopened_overlay', 'moved_overlay'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const handle = value => { assert(/^0x[0-9a-f]+$/i.test(value), `Invalid HWND: ${value}`); return BigInt(value).toString(16); };
const sameHandle = (left, right) => handle(left) === handle(right);
const sameRect = (left, right) => !!left && !!right && ['left', 'top', 'right', 'bottom'].every(key => left[key] === right[key]);
const sameIdentity = (current, initial) => !!current?.exists && !!current.pid && !!current.tid &&
  current.pid === initial.pid && current.tid === initial.tid && sameHandle(current.hwnd, initial.hwnd);
const sameState = (before, after) => sameIdentity(after, before) && sameRect(before.bounds, after.bounds) &&
  before.visible === after.visible && before.topmost === after.topmost &&
  before.affinity.querySucceeded === after.affinity.querySucceeded &&
  (!before.affinity.querySucceeded || before.affinity.value === after.affinity.value);
const visibleRole = role => role !== 'hidden_control';
const normalizedPath = value => String(value).replaceAll('\\', '/').toLowerCase();

function compareMeasurement(recorded, computed, label) {
  assert(recorded, `${label}: missing measurement`);
  for (const key of ['classification', 'pixelCount', 'rgbFnv1a64'])
    assert.equal(recorded[key], computed[key], `${label}: ${key}`);
  for (const key of ['currentBackgroundMatch', 'blackFraction', 'overlayFraction', 'unpaintedFraction'])
    assert(Number.isFinite(recorded[key]) && Math.abs(recorded[key] - computed[key]) < 1e-7, `${label}: ${key}`);
  assert.equal(recorded.backgroundPhaseMatches?.length, 3, `${label}: phase count`);
  computed.backgroundPhaseMatches.forEach((fraction, index) =>
    assert(Number.isFinite(recorded.backgroundPhaseMatches[index]) &&
      Math.abs(recorded.backgroundPhaseMatches[index] - fraction) < 1e-7, `${label}: phase ${index}`));
}

function validateTree(report) {
  assert.equal(report.kind, 'whole-application-window-audit');
  assert.equal(report.rootIdentity.pid, report.rootProcessId);
  const processes = new Map(report.processTree.map(process => [process.pid, process]));
  assert.equal(processes.size, report.processTree.length, 'Duplicate process tree PID');
  assert(processes.has(report.rootProcessId), 'Root process absent from process tree');
  assert.equal(normalizedPath(processes.get(report.rootProcessId).executablePath),
    normalizedPath(report.rootIdentity.executablePath));
  assert.equal(Date.parse(processes.get(report.rootProcessId).createdAt), Date.parse(report.rootIdentity.createdAt),
    'Root process creation time mismatch');
  for (const process of processes.values()) {
    assert(Number.isFinite(Date.parse(process.createdAt)), `PID ${process.pid}: invalid process creation time`);
    const seen = new Set(); let current = process;
    while (current.pid !== report.rootProcessId) {
      assert(!seen.has(current.pid), 'Process tree cycle'); seen.add(current.pid);
      const parent = processes.get(current.parentPid);
      assert(parent, `PID ${current.pid} is not a descendant of the application root`);
      assert(Date.parse(parent.createdAt) <= Date.parse(current.createdAt), `PID ${current.pid}: PID reuse/creation-time inversion`);
      current = parent;
    }
  }
  assert.deepEqual([...report.applicationProcessIds].sort((a, b) => a - b), [...processes.keys()].sort((a, b) => a - b));
  for (const window of report.windows.filter(window => window.isApplicationProcess))
    assert(processes.has(window.pid), `Window ${window.hwnd}: PID missing from process tree`);
  return processes;
}

export async function verifyRealApp(directory) {
  directory = path.resolve(directory);
  const evidenceHashes = [];
  const localPath = relative => {
    assert(typeof relative === 'string' && relative && !path.isAbsolute(relative), 'Evidence paths must be relative to RUN_DIR');
    const result = path.resolve(directory, relative);
    assert(result.startsWith(`${directory}${path.sep}`), 'Evidence path escapes RUN_DIR');
    return result;
  };
  const readBytes = async relative => {
    const bytes = await readFile(localPath(relative));
    evidenceHashes.push({ file: relative, sha256: sha256(bytes) }); return bytes;
  };
  const readJson = async relative => JSON.parse((await readBytes(relative)).toString('utf8').replace(/^\uFEFF/, ''));
  let manifest = null;
  try { manifest = await readJson('manifest.json'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const problems = [];
  if (!manifest) problems.push('No manifest: report discovery is exploratory and cannot establish a completed actual-overlay test.');
  if (manifest) {
    assert.equal(manifest.schemaVersion, 1, 'Unsupported manifest schema');
    assert(Number.isSafeInteger(manifest.rootProcessId) && manifest.rootProcessId > 0, 'Manifest must identify the real application root PID');
    handle(manifest.overlayHwnd); handle(manifest.setupHwnd);
    assert(!sameHandle(manifest.overlayHwnd, manifest.setupHwnd), 'Setup and actual overlay must be distinct');
    assert(Array.isArray(manifest.captures) && Array.isArray(manifest.windowStates));
  }
  const captures = manifest?.captures ?? (await readdir(path.join(directory, 'captures')).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  })).filter(name => name.endsWith('-report.json')).sort().map(name =>
    ({ reportFile: `captures/${name}`, label: name.replace(/-report.json$/, ''), role: 'unassigned' }));
  assert.equal(new Set(captures.map(item => item.reportFile)).size, captures.length, 'Duplicate capture report');
  let provenance = null;
  const provenanceFile = manifest?.applicationProvenanceFile ?? 'application-provenance.json';
  try { provenance = await readJson(provenanceFile); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const expectedPath = manifest?.expectedExecutablePath ?? provenance?.binaryPath;
  let currentBinaryHash = null;
  if (expectedPath && provenance?.binarySha256) {
    try { currentBinaryHash = sha256(await readFile(expectedPath)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const currentBuildInputs = [];
  for (const input of provenance?.inputs ?? []) {
    const filename = path.resolve(repositoryRoot, input.path);
    assert(filename.startsWith(`${repositoryRoot}${path.sep}`), 'Build provenance input escapes the repository');
    let hash = null;
    try { hash = sha256(await readFile(filename)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    currentBuildInputs.push({ path: input.path, sha256: hash, matchesRecordedBuild: !!hash && hash === input.sha256 });
  }
  const provenanceVerified = !!provenance && !!expectedPath && !!currentBinaryHash &&
    normalizedPath(expectedPath) === normalizedPath(provenance.binaryPath) &&
    currentBinaryHash === provenance.binarySha256 && provenance.binarySha256 === provenance.expectedBinarySha256 &&
    Array.isArray(provenance.inputs) && provenance.inputs.length > 0 && provenance.inputs.every(input => input.matchesRecordedBuild === true) &&
    currentBuildInputs.every(input => input.matchesRecordedBuild);
  if (!provenanceVerified) problems.push('Current application binary/build provenance is missing or does not match the recorded build.');

  const states = [];
  for (const entry of manifest?.windowStates ?? []) {
    const report = await readJson(entry.reportFile), processes = validateTree(report);
    assert.equal(report.rootProcessId, manifest.rootProcessId, `${entry.label}: wrong root process`);
    assert(expectedPath && normalizedPath(report.rootIdentity.executablePath) === normalizedPath(expectedPath), `${entry.label}: wrong application executable`);
    assert(sameHandle(entry.overlayHwnd ?? manifest.overlayHwnd, manifest.overlayHwnd), `${entry.label}: overlay identity changed`);
    assert(sameHandle(entry.setupHwnd ?? manifest.setupHwnd, manifest.setupHwnd), `${entry.label}: setup identity changed`);
    const overlay = report.windows.find(window => sameHandle(window.hwnd, manifest.overlayHwnd));
    const setup = report.windows.find(window => sameHandle(window.hwnd, manifest.setupHwnd));
    const rawPath = path.posix.join(entry.reportFile.replaceAll('\\', '/').split('/').slice(0, -1).join('/'), report.rawSnapshot);
    const raw = await readJson(rawPath);
    assert.equal(raw.truncated, false, `${entry.label}: enumeration truncated`);
    assert.equal(raw.observerPid, report.observerPid, `${entry.label}: observer PID mismatch`);
    assert.equal(raw.windows.length, report.nativeRawWindowCount, `${entry.label}: raw window count`);
    assert.equal(report.applicationWindowCount, report.windows.filter(window => window.isApplicationProcess).length,
      `${entry.label}: application window count`);
    for (const window of [overlay, setup].filter(Boolean)) {
      const rawWindow = raw.windows.find(candidate => sameHandle(candidate.hwnd, window.hwnd));
      assert(rawWindow && rawWindow.pid === window.pid, `${entry.label}: HWND absent from raw discovery`);
      assert.deepEqual(window.enumerationSources, rawWindow.enumerationSources, `${entry.label}: discovery source mismatch`);
      assert(processes.has(window.pid), `${entry.label}: HWND belongs to another application`);
    }
    const observed = roles.includes(entry.role);
    if (observed && !overlay) problems.push(`${entry.label}: actual overlay not discovered; this is not proof of HWND absence.`);
    if (observed && (!setup || setup.visible)) problems.push(`${entry.label}: setup window was not independently confirmed hidden.`);
    if (observed && overlay && overlay.visible !== visibleRole(entry.role)) problems.push(`${entry.label}: actual overlay visibility does not match requested state.`);
    states.push({ label: entry.label, role: entry.role ?? 'context', reportFile: entry.reportFile,
      sampledBefore: report.sampledBefore, sampledAfter: report.sampledAfter,
      rootProcessId: report.rootProcessId, processCount: processes.size, applicationWindowCount: report.applicationWindowCount,
      overlayDiscovered: !!overlay, overlayPid: overlay?.pid, overlayVisible: overlay?.visible,
      overlayTid: overlay?.tid, overlayAffinity: overlay?.affinity, overlayDiscoverySources: overlay?.enumerationSources ?? [],
      overlayChildWindows: report.windows.filter(window => !sameHandle(window.hwnd, manifest.overlayHwnd) &&
        sameHandle(window.root, manifest.overlayHwnd)).map(window => ({ hwnd: window.hwnd, pid: window.pid,
          visible: window.visible, class: window.class, enumerationSources: window.enumerationSources })),
      setupConfirmedHidden: !!setup && setup.visible === false, setupVisible: setup?.visible,
      observedPrivacyState: observed, processTreeVerified: true });
  }
  assert.equal(new Set(states.map(state => state.label)).size, states.length, 'Duplicate window-state label');

  const results = [];
  let attempted = 0, images = 0, pixels = 0, unavailable = 0, changed = 0, mutationCheck = false;
  for (const entry of captures) {
    if (manifest) assert(roles.includes(entry.role), `${entry.label}: unknown capture role`);
    const report = await readJson(entry.reportFile);
    assert.equal(report.kind, 'real-app-capture'); assert.equal(report.schemaVersion, 1);
    assert.equal(report.completed, true, `${entry.label}: incomplete capture report`);
    assert(Number.isInteger(report.phase) && report.phase >= 0 && report.phase < 3);
    for (const key of ['left', 'top', 'right', 'bottom']) assert(Number.isInteger(report.region[key]));
    assert(Number.isInteger(report.referenceOrigin.x) && Number.isInteger(report.referenceOrigin.y));
    const width = report.region.right - report.region.left, height = report.region.bottom - report.region.top;
    assert(width > 0 && height > 0 && width <= 8192 && height <= 8192);
    assert.deepEqual(report.methods.map(sample => sample.method), captureMethods, `${entry.label}: capture methods`);
    assert.equal(report.captureAttemptCount, captureMethods.length);
    assert.equal(report.successfulCaptureCount, report.methods.filter(sample => sample.succeeded).length);
    assert.equal(report.targetModified, false);
    assert.equal(report.physicalPanelVisibilityVerified, false);
    if (manifest) {
      assert(sameHandle(report.target.hwnd, manifest.overlayHwnd), `${entry.label}: capture targets setup or another window`);
      assert.equal(report.target.pid, manifest.rootProcessId, `${entry.label}: capture is not the actual application overlay`);
    }
    assert(report.observerPid !== report.target.pid && report.observerPid > 0);
    assert(sameRect(report.region, report.target.bounds));
    let referenceVerified = false;
    if (entry.referenceStatusFile) {
      const reference = await readJson(entry.referenceStatusFile);
      assert.equal(reference.kind, 'real-app-reference-background');
      referenceVerified = reference.state === 'running' && reference.phase === report.phase &&
        sameIdentity(reference.target, report.target) && sameRect(reference.targetBounds, report.region) &&
        reference.origin.x === report.referenceOrigin.x && reference.origin.y === report.referenceOrigin.y &&
        reference.target.visible === report.target.visible && reference.referenceVisible === true &&
        reference.targetImmediatelyPrecedesReference === true && reference.targetModified === false &&
        reference.referencePid !== report.target.pid;
      if (!referenceVerified) problems.push(`${entry.label}: reference backdrop state was not independently corroborated.`);
    } else problems.push(`${entry.label}: no saved running reference-backdrop status.`);
    const state = entry.windowStateLabel ? states.find(candidate => candidate.label === entry.windowStateLabel) : null;
    if (manifest && !state) problems.push(`${entry.label}: no explicit linked whole-application window-state report.`);
    const stateMatches = !!state && state.observedPrivacyState && state.role === entry.role &&
      state.overlayDiscovered && state.overlayPid === report.target.pid &&
      state.overlayTid === report.target.tid && state.overlayVisible === report.target.visible && state.setupConfirmedHidden;
    if (state && !stateMatches) problems.push(`${entry.label}: linked enumeration state or setup visibility does not match capture.`);
    const expectedVisibility = roles.includes(entry.role) ? report.target.visible === visibleRole(entry.role) : false;
    const samples = [];
    for (const sample of report.methods) {
      ++attempted;
      const stable = sameState(sample.targetBefore, sample.targetAfter);
      const identity = sameIdentity(sample.targetAfter, report.target);
      assert.equal(sample.targetStateStable, stable, `${entry.label}/${sample.method}: stable flag`);
      assert.equal(sample.targetIdentityMatchesInitial, identity, `${entry.label}/${sample.method}: identity flag`);
      const targetMatches = sameIdentity(sample.targetBefore, report.target) && identity &&
        sameRect(sample.targetBefore.bounds, report.region) && sameRect(sample.targetAfter.bounds, report.region);
      let classification = 'capture_unavailable', computed = null, imageHash = null;
      let imageFile = null;
      if (sample.succeeded) {
        assert.equal(sample.image, path.basename(sample.image), 'Unexpected image filename');
        imageFile = path.posix.join(entry.reportFile.replaceAll('\\', '/').split('/').slice(0, -1).join('/'), sample.image);
        const bytes = await readBytes(imageFile), image = decodeBitmap(bytes);
        assert.equal(image.width, width); assert.equal(image.height, height);
        assert.equal(sample.width, width); assert.equal(sample.height, height);
        computed = measure(image, report.phase, report.region.left - report.referenceOrigin.x,
          report.region.top - report.referenceOrigin.y);
        compareMeasurement(sample.measurement, computed, imageFile);
        classification = stable && identity ? computed.classification : 'target_state_changed_during_capture';
        assert.equal(sample.classification, classification, `${entry.label}/${sample.method}: classification`);
        imageHash = sha256(bytes); ++images; pixels += computed.pixelCount;
        if (!mutationCheck && computed.classification === 'live_background') {
          const modified = { ...image, rgb: image.rgb.slice() }; modified.rgb.fill(0, 0, 3);
          const tampered = measure(modified, report.phase, report.region.left - report.referenceOrigin.x,
            report.region.top - report.referenceOrigin.y);
          assert.notEqual(tampered.classification, 'live_background');
          assert.throws(() => compareMeasurement(sample.measurement, tampered, 'deliberately blackened real-app reference pixel'));
          mutationCheck = true;
        }
      } else {
        ++unavailable; assert.equal(sample.classification, 'capture_unavailable'); assert(!sample.image);
      }
      if (!stable || !identity || !targetMatches) ++changed;
      samples.push({ method: sample.method, succeeded: sample.succeeded, classification, measurement: computed,
        targetStateStable: stable, targetIdentityVerified: targetMatches,
        expectedVisibilityVerified: expectedVisibility && sample.targetBefore.visible === report.target.visible &&
          sample.targetAfter.visible === report.target.visible,
        imageFile, imageSha256: imageHash, error: sample.error ?? null,
        cleanMonitorCandidate: monitorMethods.includes(sample.method) && sample.succeeded === true && stable &&
          targetMatches && expectedVisibility && computed?.classification === 'live_background' && computed.blackFraction === 0 });
    }
    results.push({ label: entry.label, role: entry.role, reportFile: entry.reportFile, phase: report.phase,
      capturedAt: report.timestamp, finishedAt: report.finishedAt, targetHwnd: report.target.hwnd,
      targetPid: report.target.pid, targetVisible: report.target.visible, targetAffinity: report.target.affinity,
      region: report.region, referenceOrigin: report.referenceOrigin, fullDwmFrameSampled: true,
      referenceStatusVerified: referenceVerified, linkedWindowState: entry.windowStateLabel ?? null,
      linkedWindowStateVerified: stateMatches, samples });
  }

  const controlKey = item => JSON.stringify([item.phase, item.region.left, item.region.top, item.region.right,
    item.region.bottom, item.referenceOrigin.x, item.referenceOrigin.y]);
  const hiddenControls = results.filter(item => item.role === 'hidden_control');
  const visibleResults = results.filter(item => visibleRole(item.role) && roles.includes(item.role));
  for (const result of results) {
    result.monitorCapturesClean = monitorMethods.every(method => result.samples.find(sample => sample.method === method)?.cleanMonitorCandidate);
    result.referenceAndApplicationStateVerified = result.referenceStatusVerified && result.linkedWindowStateVerified;
  }
  for (const result of results) {
    const control = hiddenControls.find(candidate => controlKey(candidate) === controlKey(result) &&
      candidate.monitorCapturesClean && candidate.referenceAndApplicationStateVerified);
    result.matchingHiddenControl = control?.label ?? null;
    for (const sample of result.samples) {
      const controlSample = control?.samples.find(candidate => candidate.method === sample.method);
      const compare = result.role !== 'hidden_control' && monitorMethods.includes(sample.method) &&
        sample.succeeded && !!sample.imageSha256 && controlSample?.succeeded && !!controlSample.imageSha256;
      sample.exactHiddenImageMatch = compare ? sample.imageSha256 === controlSample.imageSha256 : null;
      sample.hiddenControlImageFile = compare ? controlSample.imageFile : null;
      sample.hiddenControlImageSha256 = compare ? controlSample.imageSha256 : null;
    }
    result.exactHiddenImageMatch = result.role === 'hidden_control' ? null :
      monitorMethods.every(method => result.samples.find(sample => sample.method === method)?.exactHiddenImageMatch === true);
    result.calibratedCleanMonitorCapture = result.role !== 'hidden_control' && result.monitorCapturesClean &&
      result.referenceAndApplicationStateVerified && !!result.matchingHiddenControl && result.exactHiddenImageMatch;
  }
  const observedStates = states.filter(state => state.observedPrivacyState);
  const shownStates = observedStates.filter(state => visibleRole(state.role));
  const phasesTested = [...new Set(visibleResults.map(result => result.phase))].sort();
  const stateCoverageVerified = observedStates.length > 0 && shownStates.length > 0 &&
    observedStates.every(state => state.processTreeVerified && state.overlayDiscovered && state.setupConfirmedHidden &&
      state.overlayVisible === visibleRole(state.role));
  const actualOverlayTestCompleted = !!manifest && provenanceVerified && stateCoverageVerified && visibleResults.length > 0 &&
    visibleResults.every(result => result.referenceAndApplicationStateVerified && result.matchingHiddenControl) &&
    problems.length === 0;
  const overlayEnumerable = observedStates.some(state => state.overlayDiscovered && state.overlayDiscoverySources.length > 0);
  const monitorCaptureRequirementPassed = actualOverlayTestCompleted && visibleResults.every(result => result.calibratedCleanMonitorCapture);
  const output = { schemaVersion: 1, kind: 'real-application-independent-verification', verifiedAt: new Date().toISOString(),
    targetDescription: 'Actual test-ts application Ctrl+Shift+H meeting overlay; setup window is outside the privacy target',
    manifestPresent: !!manifest, rootProcessId: manifest?.rootProcessId ?? null, overlayHwnd: manifest?.overlayHwnd ?? null,
    setupHwnd: manifest?.setupHwnd ?? null, applicationProvenanceVerified: provenanceVerified,
    currentBinarySha256: currentBinaryHash, currentBuildInputs, actualOverlayTestCompleted,
    attemptedCaptureSamples: attempted, successfulCaptureImagesVerified: images, unavailableCaptures: unavailable,
    rgbPixelsVerified: pixels, capturesWithChangedTarget: changed, tamperedBlackPixelRejected: mutationCheck,
    observedPrivacyStateCount: observedStates.length, visibleOverlayCaptureCount: visibleResults.length,
    changingBackgroundPhasesTested: phasesTested, allThreeChangingPhasesTested: phasesTested.length === 3,
    exactHiddenMonitorImageComparisonCount: visibleResults.flatMap(result => result.samples).filter(sample => sample.exactHiddenImageMatch !== null).length,
    exactHiddenMonitorImageMatchCount: visibleResults.flatMap(result => result.samples).filter(sample => sample.exactHiddenImageMatch === true).length,
    exactHiddenMonitorImageMismatchCount: visibleResults.flatMap(result => result.samples).filter(sample => sample.exactHiddenImageMatch === false).length,
    actualOverlayEnumerable: overlayEnumerable, hwndInvisibilityRequirementPassed: actualOverlayTestCompleted && !overlayEnumerable,
    monitorCaptureRequirementPassed, anyObservedMonitorBlackPixel: visibleResults.some(result => result.samples.some(sample =>
      monitorMethods.includes(sample.method) && sample.measurement?.blackFraction > 0)),
    physicalPanelVisibilityVerified: false, allLocalSoftwareInvisibilityProven: false, fullOverlayGoalAchieved: false,
    incompleteness: problems, windowStates: states, captures: results, evidenceHashes,
    limitations: ['Capture checks cover every pixel inside each recorded actual overlay DWM frame rectangle, not every screen pixel.',
      'Window capture black pixels or API denial are distinct from black masks in monitor captures.',
      'Failed, unavailable, changed-target and uncalibrated captures never count as clean omission.',
      'The synthetic background is test instrumentation; the application overlay is the privacy target.',
      'Snapshots cannot exclude changes occurring entirely between samples or observers outside the recorded user-mode APIs.',
      'Capture omission does not establish what a person sees on the physical panel.'] };
  await writeFile(path.join(directory, 'verification.json'), `${JSON.stringify(output, null, 2)}\n`);
  const captureRows = results.map(result => `<tr><th>${escapeHtml(result.label)}<br><small>${escapeHtml(result.role)} · phase ${result.phase}</small></th><td>${result.targetVisible ? 'Shown' : 'Hidden'}</td>${captureMethods.map(method => {
    const sample = result.samples.find(item => item.method === method), black = sample.measurement?.blackFraction;
    return `<td>${escapeHtml(sample.classification)}${black === null || black === undefined ? '' : `<br><small>black pixels: ${Math.round(black * sample.measurement.pixelCount).toLocaleString('en-US')} / ${sample.measurement.pixelCount.toLocaleString('en-US')}</small>`}${result.role !== 'hidden_control' && monitorMethods.includes(method) ? `<br><small>Hidden reference bytes: ${sample.exactHiddenImageMatch === true ? 'identical (SHA256)' : sample.exactHiddenImageMatch === false ? 'different' : 'unverified'}</small>` : ''}${sample.imageFile ? `<br><a href="${escapeHtml(sample.imageFile.split('/').map(encodeURIComponent).join('/'))}">Saved full-frame image</a>` : ''}</td>`;
  }).join('')}<td>${result.calibratedCleanMonitorCapture ? 'Clean, calibrated' : result.role === 'hidden_control' ? 'Hidden reference control' : 'Failed or incomplete'}<br><small>Control: ${escapeHtml(result.matchingHiddenControl ?? 'none')}</small></td></tr>`).join('\n');
  const stateRows = states.map(state => `<tr><th>${escapeHtml(state.label)}<br><small>${escapeHtml(state.role)}</small></th><td>${state.overlayDiscovered ? 'Yes' : 'Unconfirmed'}</td><td>${state.overlayVisible === undefined ? 'Unconfirmed' : state.overlayVisible ? 'Shown' : 'Hidden'}</td><td>${escapeHtml(state.overlayDiscoverySources.join(', '))}</td><td>${state.overlayChildWindows.length}</td><td>${state.setupVisible === undefined ? 'Unconfirmed' : state.setupVisible ? 'Shown (context only)' : 'Hidden'}</td><td>${state.processCount} processes<br>${state.applicationWindowCount} windows</td></tr>`).join('\n');
  const status = !manifest ? 'Incomplete: no manifest.' : !actualOverlayTestCompleted ? 'Actual overlay test is incomplete.' : overlayEnumerable ?
    'Actual Ctrl+Shift+H overlay remains enumerable.' : 'No overlay HWND was observed in the recorded discovery passes; broader invisibility is unproven.';
  const captureStatus = monitorCaptureRequirementPassed ? 'Every calibrated visible-overlay monitor capture is byte-for-byte identical to its hidden-overlay reference (SHA256), with zero black pixels.' :
    'The monitor-capture requirement has not passed the complete calibrated actual-overlay test.';
  await writeFile(path.join(directory, 'summary.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Actual test-ts overlay audit</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:32px;color:#20252b}h1{font-size:26px}table{border-collapse:collapse;font-size:13px;margin:20px 0;width:100%}th,td{border:1px solid #cbd0d5;padding:10px;text-align:left;vertical-align:top}th{background:#f2f4f6}small{font-size:12px;color:#4c5662}a{color:#245c9c}.result{padding:16px;background:#f2f4f6;border-left:4px solid #596778}li{margin:5px 0}</style>
<h1>Actual test-ts Ctrl+Shift+H overlay</h1><p class="result"><strong>${escapeHtml(status)}</strong><br>${escapeHtml(captureStatus)}</p>
<p>The target is the meeting overlay opened with <strong>Ctrl+Shift+H</strong>. The setup window is excluded from the privacy target and must be hidden during observed overlay states. This report does not substitute a synthetic overlay for the application. The checkerboard is a reference background placed behind the actual application overlay.</p>
<p>${images} saved captures independently decoded, ${pixels.toLocaleString('en-US')} RGB pixels measured; ${unavailable} capture attempts unavailable. ${changed} captures had a changed or mismatched target. ${mutationCheck ? 'A deliberately blackened reference pixel was rejected.' : 'The black-pixel mutation check has no clean reference image yet.'} Capture omission cannot verify physical panel visibility.</p>
${problems.length ? `<p><strong>Incomplete evidence:</strong></p><ul>${problems.map(problem => `<li>${escapeHtml(problem)}</li>`).join('')}</ul>` : ''}
<h2>Actual overlay discovery and application process tree</h2><table><tr><th>Observed state</th><th>Overlay enumerable</th><th>Overlay visibility</th><th>Discovery APIs</th><th>Overlay descendants</th><th>Setup</th><th>Application tree</th></tr>${stateRows || '<tr><td colspan="7">No manifest-linked whole-application window states.</td></tr>'}</table>
<h2>Full DWM frame capture measurements</h2><p>Every pixel in each recorded overlay DWM frame is checked against its current nonblack background. A single black pixel prevents a clean result. Visible-overlay monitor captures must additionally have exactly the same saved BMP SHA256 as the corresponding hidden-overlay control for the same method, phase and frame region. This exact comparison is separate from the six-level RGB tolerance used to recognize the checkerboard. ${output.exactHiddenMonitorImageMatchCount} / ${output.exactHiddenMonitorImageComparisonCount} compared monitor images are byte-for-byte identical; ${output.exactHiddenMonitorImageMismatchCount} differ. Black or unavailable captures of the excluded window are listed separately from monitor capture behavior. Hidden controls cannot demonstrate visible-overlay omission.</p>
<table><tr><th>State</th><th>Actual overlay</th>${captureMethods.map(method => `<th>${method}</th>`).join('')}<th>Monitor result</th></tr>${captureRows || '<tr><td colspan="7">No actual-application capture reports.</td></tr>'}</table>
<p>Three changing phases tested: ${phasesTested.join(', ') || 'none'}. HWND invisibility passed: ${output.hwndInvisibilityRequirementPassed ? 'yes' : 'no'}. Full goal achieved: <strong>no</strong>. User-mode enumeration and finite capture samples cannot prove invisibility to all local software.</p>
<p><a href="verification.json">Independent verification and evidence hashes</a>${manifest ? ' · <a href="manifest.json">Run manifest</a>' : ''}</p></html>`);
  console.log(JSON.stringify({ actualOverlayTestCompleted, overlayEnumerable, monitorCaptureRequirementPassed,
    images, pixels, unavailable, problems: problems.length, summary: path.join(directory, 'summary.html') }, null, 2));
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node tools/window-audit/verify-real-app.mjs RUN_DIR');
  await verifyRealApp(process.argv[2]);
}
