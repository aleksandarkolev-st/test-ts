"""Bounded, calibrated eye-only FLX correction. Frames are BGR, model crops RGB.

Anchor ordering follows the released FLX system (BSD notice in
third-party/FLX-LICENSE.txt). The original training notebook converts to RGB;
preserve that order for inference and convert back for OpenCV compositing.
"""
from dataclasses import dataclass
import math
import time
import cv2
import numpy as np

EYES = {"L": ([362,385,387,263,373,380], 473), "R": ([33,160,158,133,153,144], 468)}
INPUTS = ["inputs/input_img:0", "inputs/input_fp:0", "inputs/input_ang:0"]
YY, XX = np.mgrid[:48,:64].astype(np.float32)


@dataclass
class Eye:
    points: np.ndarray
    iris: np.ndarray
    openness: float
    gaze: np.ndarray


@dataclass
class Observation:
    eyes: dict
    gaze: np.ndarray
    pose: np.ndarray


def observation(landmarks, width, height, matrix=None):
    points = np.array([(p.x*width,p.y*height) for p in landmarks],np.float32)
    eyes = {}
    for side, (indices, iris_index) in EYES.items():
        p = points[indices]
        axis = p[3]-p[0]
        span = float(np.linalg.norm(axis))
        if span < 12 or not np.isfinite(p).all():
            return None
        axis /= span
        vertical = np.array([-axis[1],axis[0]],np.float32)
        iris = points[iris_index]
        center = (p[0]+p[3])/2
        gaze = np.array([np.dot(iris-center,vertical)/span,np.dot(iris-center,axis)/span],np.float32)
        openness = float((np.linalg.norm(p[1]-p[5])+np.linalg.norm(p[2]-p[4]))/(2*span))
        eyes[side] = Eye(p,iris,openness,gaze)
    pose = np.zeros(3,np.float32)
    if matrix is not None:
        r = np.asarray(matrix)[:3,:3]
        r = r / np.maximum(np.linalg.norm(r,axis=0),1e-6)
        pose = np.degrees([math.atan2(r[2,1],r[2,2]),math.atan2(-r[2,0],math.hypot(r[2,1],r[2,2])),math.atan2(r[1,0],r[0,0])]).astype(np.float32)
    if not np.isfinite(pose).all():
        return None
    return Observation(eyes,(eyes["L"].gaze+eyes["R"].gaze)/2,pose)


def eye_input(frame, eye, side):
    points = eye.points
    # FLX training/system crops are centered between the eye corners. Using
    # the lid-point mean shifts the crop when the eyelids are asymmetric.
    cx,cy = (points[0]+points[3])/2
    length = abs(float(points[3,0]-points[0,0]))
    half_width = length*.75
    crop_height = half_width*1.5
    x0,x1 = int(cx-half_width),int(cx+half_width)
    y0,y1 = int(cy-crop_height*7/12),int(cy+crop_height*5/12)
    # Clipped crops change the learned geometry. Pass through instead of
    # wrapping negative Python indices or correcting a partially visible eye.
    h,w = frame.shape[:2]
    if x0<0 or y0<0 or x1>w or y1>h or x1-x0<12 or y1-y0<12:
        return None
    crop = frame[y0:y1,x0:x1]
    image = cv2.cvtColor(cv2.resize(crop,(64,48)),cv2.COLOR_BGR2RGB).astype(np.float32)/255
    sequence = [3,2,1,0,5,4] if side=="L" else [0,1,2,3,4,5]
    anchors=[]
    for index in sequence:
        px,py = points[index]
        rx=int((px-x0)*64/(x1-x0)); ry=int((py-y0)*48/(y1-y0))
        anchors.extend([XX-rx,YY-ry])
    return image[None],np.stack(anchors,axis=-1)[None],(x0,y0,x1,y1)


def blend_eye(frame, prediction, bounds, eye):
    x0,y0,x1,y1 = bounds
    corrected=cv2.cvtColor(cv2.resize(prediction,(x1-x0,y1-y0)),cv2.COLOR_RGB2BGR)
    if not np.isfinite(corrected).all():
        return
    points=eye.points
    center=points.mean(axis=0)-[x0,y0]
    axis=points[3]-points[0]; span=float(np.linalg.norm(axis)); axis/=span
    vertical=np.array([-axis[1],axis[0]])
    yy,xx=np.mgrid[:y1-y0,:x1-x0]
    relative=np.stack([xx-center[0],yy-center[1]],axis=-1)
    u=relative@axis/(span*.62);v=relative@vertical/(span*.30)
    radius=np.sqrt(u*u+v*v)
    mask=np.clip((1-radius)/.22,0,1).astype(np.float32)
    # Explicitly zero all crop edges. The surrounding face stays byte-exact.
    mask[:2]=0;mask[-2:]=0;mask[:,:2]=0;mask[:,-2:]=0
    original=frame[y0:y1,x0:x1].astype(np.float32)
    mixed=original*(1-mask[...,None])+np.clip(corrected*255,0,255)*mask[...,None]
    frame[y0:y1,x0:x1]=np.rint(mixed).clip(0,255).astype(np.uint8)


class Corrector:
    def __init__(self, sessions, max_vertical=12):
        self.sessions=sessions
        self.max_vertical=float(np.clip(max_vertical,0,15))
        self.enabled=True
        self.camera=None
        self.notes=None
        self.filtered=None
        self.last_time=None
        self.collecting=None
        self.samples=[]
        self.deadline=0
        self.message="Look at the camera and calibrate, then calibrate while reading your notes."

    def begin_calibration(self, target, now=None):
        if target not in ("camera","notes"):
            raise ValueError("Unknown calibration target")
        if target=="notes" and self.camera is None:
            raise ValueError("Calibrate looking at the camera first")
        self.collecting=target;self.samples=[];self.deadline=(time.perf_counter() if now is None else now)+1.5
        self.message="Hold your gaze steady until calibration finishes."

    def calibrate(self, current, now):
        if self.collecting is None:
            return
        if current and all(eye.openness>.17 for eye in current.eyes.values()):
            self.samples.append(np.concatenate([current.gaze,current.pose]))
        if now<self.deadline:
            return
        target=self.collecting;self.collecting=None
        if len(self.samples)<10:
            self.message="Calibration needs a visible face with open eyes. Try again."
            return
        sample=np.median(self.samples,axis=0)
        if np.max(np.std(np.asarray(self.samples)[:,:2],axis=0))>.025:
            self.message="Gaze moved during calibration. Hold it steady and try again."
            return
        if target=="camera":
            self.camera=sample;self.notes=None;self.message="Camera gaze calibrated. Now look at your notes and calibrate notes."
        elif sample[0]-self.camera[0]<.025 or abs(sample[1]-self.camera[1])>.10:
            self.message="Notes must be below the camera with only a small sideways shift. Try again."
        else:
            self.notes=sample;self.message="Correction calibrated for the camera and your notes."
        self.filtered=None;self.last_time=None

    def apply(self, frame, current, now=None, blinks=None):
        now=time.perf_counter() if now is None else now
        self.calibrate(current,now)
        result=frame.copy()
        status={"calibrated":self.camera is not None and self.notes is not None,"cameraCalibrated":self.camera is not None,"calibrating":self.collecting,
                "face":current is not None,"correcting":False,"vertical":0.,"horizontal":0.,"message":self.message}
        if current is None or not self.enabled or not status["calibrated"] or self.collecting:
            self.filtered=None;self.last_time=None
            return result,status
        delta=current.pose-self.camera[2:]
        delta=(delta+180)%360-180
        # The model was trained with zero head pose. Large turns pass through.
        if abs(delta[0])>18 or abs(delta[1])>12 or abs(delta[2])>12:
            status["message"]="Head turned outside the small correction range."
            self.filtered=None;self.last_time=None
            return result,status
        if self.filtered is None:
            self.filtered=current.gaze.copy()
        else:
            dt=max(0,now-self.last_time)
            self.filtered+= (1-math.exp(-dt/.06))*(current.gaze-self.filtered)
        self.last_time=now
        relative=self.filtered-self.camera[:2]
        fraction=relative[0]/(self.notes[0]-self.camera[0])
        horizontal=-float(relative[1])*60
        if fraction<=.08 or fraction>1.5 or abs(horizontal)>8:
            status["message"]="Looking outside the calibrated notes range."
            return result,status
        vertical=float(np.clip(fraction,0,1)*self.max_vertical)
        horizontal=float(np.clip(horizontal,-3,3))
        if vertical<.5:
            return result,status
        status.update(vertical=vertical,horizontal=horizontal)
        for side,eye in current.eyes.items():
            # Preserve each blink immediately, without temporal filtering.
            if eye.openness<.15 or (blinks or {}).get(side,0)>.45:
                continue
            extracted=eye_input(frame,eye,side)
            if extracted is None:
                continue
            image,anchors,bounds=extracted
            prediction=self.sessions[side].run(None,{INPUTS[0]:image,INPUTS[1]:anchors,INPUTS[2]:np.array([[vertical,horizontal]],np.float32)})[0][0]
            blend_eye(result,prediction,bounds,eye)
            status["correcting"]=True
        return result,status
