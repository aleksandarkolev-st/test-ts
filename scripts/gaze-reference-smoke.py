"""Actual MediaPipe landmarks → FLX/DirectML → eye-only blend on a public image.

Artificial calibration exercises integration; this is not a naturalness test.
Download the portrait used by Google's Face Landmarker sample separately:
https://storage.googleapis.com/mediapipe-assets/business-person.png
"""
import argparse
import hashlib
import json
from pathlib import Path
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

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', type=Path, required=True)
parser.add_argument('--device', type=int, default=1)
args = parser.parse_args()
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
with mp.tasks.vision.FaceLandmarker.create_from_options(options) as detector:
    for i in range(35):
        started = time.perf_counter()
        result = detector.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB,
            data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)), i * 33)
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
        outside = np.ones(frame.shape[:2], bool)
        for side, eye in current.eyes.items():
            bounds = eye_input(frame, eye, side)[2]
            x0, y0, x1, y1 = bounds
            outside[y0:y1, x0:x1] = False
        assert np.array_equal(frame[outside], output[outside])
        changed = int(np.count_nonzero(np.any(frame != output, axis=2)))
        assert changed > 0
        blink, blink_state = corrector.apply(frame, current, now=(i + .5) / 30,
            blinks={'L': 1., 'R': 1.})
        assert np.array_equal(blink, frame) and not blink_state['correcting']
        counts.append(changed)
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
    verticalDegrees=12, outsideEyeCropsUnchanged=True, immediateBlinkPassthrough=True,
    directionProbe=direction,
    medianChangedEyePixels=float(np.median(counts)),
    frameShape=list(frame.shape), warmedLandmarksMs=float(np.median(landmark_timings[5:])),
    warmedCorrectionMs=float(np.median(correction_timings[5:])),
    warmedLandmarksAndCorrectionMs=float(np.median(timings[5:])),
    warmedP95Ms=float(np.percentile(timings[5:], 95)))
artifact = root / 'artifacts/gaze'
artifact.mkdir(parents=True, exist_ok=True)
(artifact / 'face-integration.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))
