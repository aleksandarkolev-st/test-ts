"""Actual MediaPipe landmarks → FLX/DirectML → eye-only blend on a public image.

Artificial calibration exercises integration; this is not a naturalness test.
Download the portrait used by Google's Face Landmarker sample separately:
https://storage.googleapis.com/mediapipe-assets/business-person.png
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import time
import cv2
import mediapipe as mp
import numpy as np

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'camera'))
from gaze_core import Corrector, observation, eye_input, blend_eye, INPUTS
from gaze_worker import sessions
from dxgi_adapters import adapters


def verify_outside_unchanged(source, output, bounds):
    # Compare rectangular views, avoiding full-image boolean gather copies.
    # The Y bands and merged X intervals cover every pixel outside both eyes.
    height, width = source.shape[:2]
    edges = sorted({0, height, *(b[1] for b in bounds), *(b[3] for b in bounds)})
    for y0, y1 in zip(edges, edges[1:]):
        cursor = 0
        intervals = sorted((b[0], b[2]) for b in bounds if b[1] < y1 and b[3] > y0)
        for x0, x1 in intervals:
            if x0 > cursor:
                assert np.array_equal(source[y0:y1, cursor:x0], output[y0:y1, cursor:x0])
            cursor = max(cursor, x1)
        if cursor < width:
            assert np.array_equal(source[y0:y1, cursor:width], output[y0:y1, cursor:width])


# Negative controls: a changed pixel must be accepted exactly inside the
# rectangle union, including overlaps, and rejected at every other position.
control = np.zeros((8, 8, 3), np.uint8)
control_bounds = [(1, 1, 4, 4), (3, 2, 7, 5)]
for control_y in range(8):
    for control_x in range(8):
        changed_control = control.copy()
        changed_control[control_y, control_x] = 255
        inside = any(x0 <= control_x < x1 and y0 <= control_y < y1
            for x0, y0, x1, y1 in control_bounds)
        try:
            verify_outside_unchanged(control, changed_control, control_bounds)
        except AssertionError:
            assert not inside
        else:
            assert inside

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', type=Path, required=True)
parser.add_argument('--device', type=int, default=1)
parser.add_argument('--duration', type=float, default=0,
    help='Replay for this many wall-clock seconds; zero keeps the 35-frame probe')
parser.add_argument('--fps', type=float, default=30)
parser.add_argument('--report-name', default='face-integration')
args = parser.parse_args()
if not np.isfinite(args.duration) or args.duration < 0 or not 1 <= args.fps <= 60:
    parser.error('Use a finite nonnegative duration and FPS from 1 to 60')
if not re.fullmatch(r'[A-Za-z0-9_-]+', args.report_name):
    parser.error('Report name must be a simple filename without an extension')
frame = cv2.imread(str(args.image))
assert frame is not None
source_frame = frame.copy()
scale = min(1280 / frame.shape[1], 720 / frame.shape[0])
resized = cv2.resize(frame, (round(frame.shape[1] * scale), round(frame.shape[0] * scale)))
frame = np.zeros((720, 1280, 3), np.uint8)
offset = (1280 - resized.shape[1]) // 2
frame[:, offset:offset + resized.shape[1]] = resized
device = next(a for a in adapters() if a['index'] == args.device)
assert not device['software']
models = root / 'models/gaze'
options = mp.tasks.vision.FaceLandmarkerOptions(
    base_options=mp.tasks.BaseOptions(model_asset_path=str(models / 'face_landmarker.task')),
    running_mode=mp.tasks.vision.RunningMode.VIDEO, num_faces=1,
    output_face_blendshapes=True, output_facial_transformation_matrixes=True)
corrector = Corrector(sessions(models, args.device), 12)
timings = []
landmark_timings = []
correction_timings = []
counts = []
loop_started = time.perf_counter()
next_frame = loop_started
last_progress = loop_started
i = 0
timestamp = -1
with mp.tasks.vision.FaceLandmarker.create_from_options(options) as detector:
    while time.perf_counter() - loop_started < args.duration if args.duration else i < 35:
        if args.duration:
            time.sleep(max(0, next_frame - time.perf_counter()))
            if time.perf_counter() - loop_started >= args.duration:
                break
        started = time.perf_counter()
        timestamp = max(timestamp + 1, int((started - loop_started) * 1000)) if args.duration else i * 33
        result = detector.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB,
            data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)), timestamp)
        assert len(result.face_landmarks) == 1
        current = observation(result.face_landmarks[0], frame.shape[1], frame.shape[0],
            result.facial_transformation_matrixes[0])
        assert current is not None
        landmarks_done = time.perf_counter()
        # The real image supplies landmarks and crops. Only calibration is
        # artificial, placing the observed gaze at the requested notes limit.
        corrector.camera = np.concatenate([current.gaze - [.05, 0], current.pose])
        corrector.notes = np.concatenate([current.gaze, current.pose])
        corrector.filtered = None
        output, state = corrector.apply(frame, current, now=i / 30)
        correction_done = time.perf_counter()
        landmark_timings.append((landmarks_done - started) * 1000)
        correction_timings.append((correction_done - landmarks_done) * 1000)
        timings.append((correction_done - started) * 1000)
        assert state['correcting'] and 11.99 <= state['vertical'] <= 12.01
        bounds_list = []
        for side, eye in current.eyes.items():
            bounds = eye_input(frame, eye, side)[2]
            bounds_list.append(bounds)
        verify_outside_unchanged(frame, output, bounds_list)
        x0, y0 = min(b[0] for b in bounds_list), min(b[1] for b in bounds_list)
        x1, y1 = max(b[2] for b in bounds_list), max(b[3] for b in bounds_list)
        changed = int(np.count_nonzero(np.any(frame[y0:y1, x0:x1] != output[y0:y1, x0:x1], axis=2)))
        assert changed > 0
        blink, blink_state = corrector.apply(frame, current, now=(i + .5) / 30,
            blinks={'L': 1., 'R': 1.})
        assert np.array_equal(blink, frame) and not blink_state['correcting']
        counts.append(changed)
        i += 1
        now = time.perf_counter()
        if args.duration:
            # Skip missed nominal frames instead of building a replay queue.
            next_frame = loop_started + (int((now - loop_started) * args.fps) + 1) / args.fps
            if now - last_progress >= 60:
                print(json.dumps(dict(event='progress', elapsedSeconds=now - loop_started,
                    correctedFrames=i, warmedMedianMs=float(np.median(timings[5:])))), flush=True)
                last_progress = now
loop_elapsed = time.perf_counter() - loop_started
assert len(counts) > 5, 'Probe must produce enough frames for warmed timings'
if args.duration:
    assert loop_elapsed >= args.duration
# Use independent IMAGE detections on the full-resolution public portrait.
# This checks the learned model's actual direction, rather than its status
# field or the supplied angle alone. No portrait/processed pixels are saved.
direction_options = mp.tasks.vision.FaceLandmarkerOptions(
    base_options=mp.tasks.BaseOptions(model_asset_path=str(models / 'face_landmarker.task')),
    num_faces=1)
direction = {}
with mp.tasks.vision.FaceLandmarker.create_from_options(direction_options) as detector:
    def observe_image(image):
        detection = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB,
            data=cv2.cvtColor(image, cv2.COLOR_BGR2RGB)))
        assert len(detection.face_landmarks) == 1
        return observation(detection.face_landmarks[0], image.shape[1], image.shape[0])

    source = observe_image(source_frame)
    assert source is not None
    for name, angles in [('zero', [0, 0]), ('up', [12, 0]), ('down', [-12, 0]),
                         ('right', [0, 3]), ('left', [0, -3])]:
        output = source_frame.copy()
        for side, eye in source.eyes.items():
            image, anchors, bounds = eye_input(source_frame, eye, side)
            prediction = corrector.sessions[side].run(None, {
                INPUTS[0]: image, INPUTS[1]: anchors,
                INPUTS[2]: np.array([angles], np.float32)})[0][0]
            blend_eye(output, prediction, bounds, eye)
        measured = observe_image(output)
        assert measured is not None
        direction[name] = dict(inputDegrees=angles, measuredGaze=measured.gaze.tolist())
    assert direction['up']['measuredGaze'][0] < direction['zero']['measuredGaze'][0]
    assert direction['down']['measuredGaze'][0] > direction['zero']['measuredGaze'][0]
    assert direction['right']['measuredGaze'][1] > direction['zero']['measuredGaze'][1]
    assert direction['left']['measuredGaze'][1] < direction['zero']['measuredGaze'][1]

report = dict(passed=True, scope='Public static face; artificial calibration; no naturalness or call-latency assertion',
    source='https://storage.googleapis.com/mediapipe-assets/business-person.png',
    imageSha256=hashlib.sha256(args.image.read_bytes()).hexdigest(), device=device,
    detectedLandmarks=len(result.face_landmarks[0]), correctedFrames=len(counts),
    requestedDurationSeconds=args.duration, replayElapsedSeconds=loop_elapsed,
    targetFps=args.fps if args.duration else None,
    replayFpsIncludingValidation=len(counts) / loop_elapsed,
    verticalDegrees=12, outsideEyeCropsUnchanged=True, immediateBlinkPassthrough=True,
    directionProbe=direction,
    medianChangedEyePixels=float(np.median(counts)),
    frameShape=list(frame.shape), warmedLandmarksMs=float(np.median(landmark_timings[5:])),
    warmedCorrectionMs=float(np.median(correction_timings[5:])),
    warmedLandmarksAndCorrectionMs=float(np.median(timings[5:])),
    warmedP95Ms=float(np.percentile(timings[5:], 95)))
artifact = root / 'artifacts/gaze'
artifact.mkdir(parents=True, exist_ok=True)
(artifact / f'{args.report_name}.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))
