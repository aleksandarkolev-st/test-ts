import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const methods = ['gdi_monitor', 'print_window', 'desktop_duplication', 'wgc_window', 'wgc_monitor'];
const monitorMethods = ['gdi_monitor', 'desktop_duplication', 'wgc_monitor'];
const caseNames = ['background_only', 'ordinary_tool_popup', 'wda_monitor_popup', 'wda_excluded_popup',
  'ordinary_child', 'affinity_requested_on_child', 'exclude_then_reparent', 'surface_unprotected_alpha',
  'surface_protected', 'surface_protected_alpha'];
const palettes = [
  [[32, 96, 192], [48, 64, 144]],
  [[64, 160, 80], [32, 112, 112]],
  [[192, 112, 32], [160, 64, 64]],
];
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const readJson = async filename => JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function decodeBitmap(bytes) {
  assert.equal(bytes.readUInt16LE(0), 0x4d42, 'Not a BMP');
  assert.equal(bytes.readUInt32LE(2), bytes.length, 'BMP length mismatch');
  const offset = bytes.readUInt32LE(10), header = bytes.readUInt32LE(14);
  assert.equal(header, 40, 'Unexpected BMP header');
  const width = bytes.readInt32LE(18), signedHeight = bytes.readInt32LE(22), height = Math.abs(signedHeight);
  assert(width > 0 && height > 0 && width <= 8192 && height <= 8192);
  assert.equal(bytes.readUInt16LE(26), 1); assert.equal(bytes.readUInt16LE(28), 32); assert.equal(bytes.readUInt32LE(30), 0);
  assert(offset >= 54 && offset + width * height * 4 <= bytes.length);
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; ++y) for (let x = 0; x < width; ++x) {
    const source = offset + ((signedHeight < 0 ? y : height - 1 - y) * width + x) * 4;
    const target = (y * width + x) * 3;
    rgb[target] = bytes[source + 2]; rgb[target + 1] = bytes[source + 1]; rgb[target + 2] = bytes[source];
  }
  return { width, height, rgb };
}

export function measure(image, phase, localX, localY) {
  const total = image.width * image.height, background = [0, 0, 0];
  let black = 0, magenta = 0, sentinel = 0, hash = 14695981039346656037n;
  const close = (a, b) => a.every((component, i) => Math.abs(component - b[i]) <= 6);
  for (let y = 0; y < image.height; ++y) for (let x = 0; x < image.width; ++x) {
    const index = (y * image.width + x) * 3;
    const pixel = [image.rgb[index], image.rgb[index + 1], image.rgb[index + 2]];
    const tile = (Math.floor((x + localX) / 24) + Math.floor((y + localY) / 24)) & 1;
    for (let p = 0; p < 3; ++p) if (close(pixel, palettes[p][tile])) ++background[p];
    if (pixel.every(v => v <= 6)) ++black;
    if (close(pixel, [255, 0, 255])) ++magenta;
    if (pixel.every(v => v === 0xa5)) ++sentinel;
    for (const component of pixel) hash = BigInt.asUintN(64, (hash ^ BigInt(component)) * 1099511628211n);
  }
  let classification = 'mixed_or_unexpected';
  if (sentinel / total >= 0.98) classification = 'unpainted_capture_buffer';
  else if (background[phase] === total) classification = 'live_background';
  else if (black / total >= 0.98) classification = 'black_mask';
  else if (magenta / total >= 0.98) classification = 'overlay_visible';
  else if (background.some((count, p) => p !== phase && count / total >= 0.98)) classification = 'stale_or_wrong_background_phase';
  return { classification, pixelCount: total, currentBackgroundMatch: background[phase] / total,
    backgroundPhaseMatches: background.map(count => count / total), blackFraction: black / total,
    overlayFraction: magenta / total, unpaintedFraction: sentinel / total, rgbFnv1a64: `0x${hash.toString(16).toUpperCase()}` };
}

function compareMeasurement(recorded, computed, label) {
  for (const key of ['classification', 'pixelCount', 'rgbFnv1a64']) assert.equal(recorded[key], computed[key], `${label}: ${key}`);
  for (const key of ['currentBackgroundMatch', 'blackFraction', 'overlayFraction', 'unpaintedFraction'])
    assert(Math.abs(recorded[key] - computed[key]) < 1e-7, `${label}: ${key}`);
  computed.backgroundPhaseMatches.forEach((value, i) => assert(Math.abs(recorded.backgroundPhaseMatches[i] - value) < 1e-7, `${label}: phase ${i}`));
}

export async function verify(directory) {
  directory = path.resolve(directory);
  const reportBytes = await readFile(path.join(directory, 'report.json'));
  const report = JSON.parse(reportBytes.toString('utf8'));
  assert.equal(report.kind, 'window-audit-self-test');
  assert.notEqual(report.observerPid, report.rendererPid); assert.equal(report.independentProcesses, true);
  assert.equal(report.allLocalSoftwareInvisibilityProven, false); assert.equal(report.physicalDisplayVisibilityVerified, false);
  const enumeration = await readJson(path.join(directory, 'enumeration.json'));
  assert.equal(enumeration.truncated, false); assert.equal(enumeration.observerPid, report.observerPid);
  const roles = Object.fromEntries(report.fixtureWindows.map(item => [item.role, item.hwnd]));
  assert.equal(report.fixtureWindows.length, 10);
  for (const fixture of report.fixtureWindows) {
    assert.equal(fixture.found, true, fixture.role); assert.equal(fixture.requiredDiscoveryPathsPresent, true, fixture.role);
    assert.equal(fixture.expectedMetadataPresent, true, fixture.role);
    const window = enumeration.windows.find(item => item.hwnd === fixture.hwnd);
    assert(window && window.pid === report.rendererPid && window.enumerationSources.length > 0, fixture.role);
    if (fixture.role === 'message_only') assert(window.enumerationSources.includes('FindWindowEx.messageOnly'));
    if (['child', 'grandchild', 'foreign_child'].includes(fixture.role)) {
      assert(window.enumerationSources.includes('EnumChildWindows'));
      assert(window.enumerationSources.includes('FindWindowEx.child'));
      assert(!window.enumerationSources.includes('EnumWindows'));
    }
    if (fixture.role === 'foreign_child') { assert.equal(window.parentPid, report.observerPid); assert(window.findings.includes('cross_process_parent')); }
    if (fixture.role === 'grandchild') assert.equal(window.parent, roles.child);
    if (fixture.role === 'owned_popup') assert.equal(window.owner, roles.scene_host);
    if (fixture.role === 'zero_alpha') { assert.equal(window.layeredAttributes.alpha, 0); assert(window.findings.includes('zero_opacity')); }
    if (fixture.role === 'hidden_root') assert.equal(window.visible, false);
    if (fixture.role === 'tool_popup') assert(window.enumerationSources.includes('EnumWindows'));
  }
  const watch = await readJson(path.join(directory, 'watch-fixture.json'));
  const shown = watch.shownChanges.find(item => item.after?.hwnd === roles.tool_popup);
  const hidden = watch.hiddenChanges.find(item => item.after?.hwnd === roles.tool_popup);
  assert(shown && hidden && !shown.before.visible && shown.after.visible && hidden.before.visible && !hidden.after.visible);
  assert(report.classifierPassed && report.classifierTests.every(test => test.passed));
  assert(report.enumerationPassed && report.watchFixturePassed && watch.passed);

  let samples = 0, images = 0, pixels = 0, unavailable = 0, mutationCheck = false;
  const hashes = [], matrix = [];
  if (report.captureRequested) assert.deepEqual(report.cases.map(item => item.name), caseNames);
  const scene = enumeration.windows.find(item => item.hwnd === roles.scene_host);
  const localX = report.sampleLocalOrigin?.x ?? report.sampleRegion?.left - scene.bounds.left;
  const localY = report.sampleLocalOrigin?.y ?? report.sampleRegion?.top - scene.bounds.top;
  for (const item of report.cases) {
    assert.deepEqual(item.phases.map(phase => phase.phase), [0, 1, 2]);
    const perMethod = {}, blackFractions = {};
    for (const phase of item.phases) {
      assert(!phase.error, `${item.name}: phase setup failed: ${phase.error}`);
      assert.deepEqual(phase.captures.map(sample => sample.method), methods);
      if (phase.phase === 0) assert.equal(phase.subjectEnumerable, true, item.name);
      for (const sample of phase.captures) {
        ++samples; let classification = 'capture_unavailable';
        if (sample.succeeded) {
          assert.equal(sample.image, path.basename(sample.image), 'Unexpected image path');
          const bytes = await readFile(path.join(directory, sample.image)), image = decodeBitmap(bytes);
          assert.equal(image.width, report.sampleRegion.right - report.sampleRegion.left);
          assert.equal(image.height, report.sampleRegion.bottom - report.sampleRegion.top);
          const computed = measure(image, phase.phase, localX, localY);
          compareMeasurement(sample.measurement, computed, sample.image);
          classification = computed.classification; ++images; pixels += computed.pixelCount;
          hashes.push({ file: sample.image, sha256: sha256(bytes), rgbFnv1a64: computed.rgbFnv1a64 });
          (blackFractions[sample.method] ??= []).push(computed.blackFraction);
          if (!mutationCheck && classification === 'live_background') {
            const modified = { ...image, rgb: image.rgb.slice() }; modified.rgb.fill(0, 0, 3);
            const tampered = measure(modified, phase.phase, localX, localY);
            assert.equal(tampered.classification, 'mixed_or_unexpected');
            assert.throws(() => compareMeasurement(sample.measurement, tampered, 'deliberately changed pixel'));
            mutationCheck = true;
          }
        } else { ++unavailable; assert.equal(sample.classification, 'capture_unavailable'); assert(!sample.image); }
        (perMethod[sample.method] ??= []).push(classification);
      }
    }
    matrix.push({ name: item.name, subjectEnumerable: item.phases[0].subjectEnumerable,
      enumerationSources: item.phases[0].subjectWindow.enumerationSources, methods: perMethod, blackFractions,
      allMonitorSamplesShowLiveBackground: monitorMethods.every(method => perMethod[method]?.length === 3 && perMethod[method].every(value => value === 'live_background')),
      combinedRequirementSurvived: false, physicalVisibilityVerified: false });
  }
  const controls = [];
  for (const method of monitorMethods) if (report.captureRequested) {
    const checks = [['background_only', 'live_background'], ['ordinary_tool_popup', 'overlay_visible'],
      ['wda_monitor_popup', 'black_mask'], ['wda_excluded_popup', 'live_background']];
    const passed = checks.every(([name, expected]) => matrix.find(item => item.name === name).methods[method].every(value => value === expected));
    assert.equal(report.captureControls.find(item => item.method === method).passed, passed);
    controls.push({ method, passed });
  }
  const output = { schemaVersion: 1, verifiedAt: new Date().toISOString(), reportSha256: sha256(reportBytes),
    independentObserverAndRenderer: true, fixtureWindowsVerified: report.fixtureWindows.length,
    enumerationAndWatchVerified: true, attemptedCaptureSamples: samples, successfulCaptureImagesVerified: images,
    rgbPixelsVerified: pixels, unavailableCaptures: unavailable, tamperedPixelRejected: mutationCheck,
    captureControls: controls, matrix, imageHashes: hashes,
    allLocalSoftwareInvisibilityProven: false, physicalDisplayVisibilityVerified: false, fullOverlayGoalAchieved: false };
  await writeFile(path.join(directory, 'verification.json'), `${JSON.stringify(output, null, 2)}\n`);
  const compact = values => [...new Set(values)].map(value => `${value} (${values.filter(item => item === value).length}/3)`).join(', ');
  const rows = matrix.map(item => `<tr><th>${escapeHtml(item.name)}</th><td>Yes</td>${methods.map(method => `<td>${escapeHtml(compact(item.methods[method]))}</td>`).join('')}</tr>`).join('\n');
  const gallery = report.cases.filter(item => ['ordinary_tool_popup', 'wda_monitor_popup', 'wda_excluded_popup', 'surface_protected_alpha'].includes(item.name))
    .map(item => { const sample = item.phases[0].captures.find(capture => capture.method === 'gdi_monitor');
      return `<figure><img src="${encodeURIComponent(sample.image)}" width="192"><figcaption>${escapeHtml(item.name)}<br>${escapeHtml(sample.measurement.classification)}</figcaption></figure>`; }).join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>Window Audit results</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:32px;color:#20252b}h1{font-size:26px}table{border-collapse:collapse;font-size:13px}th,td{border:1px solid #cbd0d5;padding:10px;text-align:left}th{background:#f2f4f6}figure{display:inline-block;margin:12px 24px 12px 0}figcaption{font-size:12px}img{image-rendering:pixelated;border:1px solid #87909a}a{color:#245c9c}</style>
<h1>Window Audit: measured results</h1><p>${images} saved captures independently verified (${pixels.toLocaleString('en-US')} RGB pixels); ${unavailable} capture attempts unavailable. ${report.fixtureWindows.length} enumeration fixtures and the show/hide watch fixture passed.</p>
<p><strong>Every tested subject remains enumerable. None passes the combined requirement.</strong> Physical panel visibility and invisibility to all local software are unverified.</p>
${gallery}<table><tr><th>Configuration</th><th>Enumerable</th>${methods.map(method => `<th>${escapeHtml(method)}</th>`).join('')}</tr>${rows}</table>
<p>Each cell covers three changing background phases. Popup window captures target the popup; child/surface window captures target the scene host. A black or unavailable capture of an excluded popup is distinct from a black mask in monitor capture.</p>
<p>The sampled ${report.sampleRegion ? report.sampleRegion.right - report.sampleRegion.left : 0} × ${report.sampleRegion ? report.sampleRegion.bottom - report.sampleRegion.top : 0} region covers ${report.sampleRegionCoversFullFixtureOverlay ? 'the entire test overlay rectangle' : 'an interior test area'}. Only the recorded APIs are measured. Captures cannot establish physical panel visibility. <a href="report.json">Raw report</a> · <a href="verification.json">Independent verification and image hashes</a> · <a href="enumeration.json">Enumeration metadata</a></p>`;
  await writeFile(path.join(directory, 'summary.html'), html);
  console.log(JSON.stringify({ verified: true, fixtureWindows: output.fixtureWindowsVerified, samples, images, pixels, unavailable,
    tamperedPixelRejected: mutationCheck, captureControls: controls, summary: path.join(directory, 'summary.html') }, null, 2));
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node tools/window-audit/verify-report.mjs SELF_TEST_DIRECTORY');
  await verify(process.argv[2]);
}
