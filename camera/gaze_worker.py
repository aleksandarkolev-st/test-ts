"""Local camera → MediaPipe → FLX/DirectML → OBS Virtual Camera worker.

JSON control/status on stdio; camera images are never written to disk or sent
to a network. Preview frames are optional, transient JPEGs for the local UI.
"""
import argparse
import base64
import json
from pathlib import Path
import queue
import sys
import threading
import time
import cv2
import mediapipe as mp
import numpy as np
import onnxruntime as ort
import pyvirtualcam
from cv2_enumerate_cameras import enumerate_cameras
from gaze_core import Corrector, observation

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from dxgi_adapters import adapters


def emit(event, **payload):
    print(json.dumps({"event":event,**payload},separators=(",",":")),flush=True)


class LatestFrame:
    def __init__(self,index,width,height,fps):
        self.camera=cv2.VideoCapture(index,cv2.CAP_DSHOW)
        if not self.camera.isOpened():
            self.camera.release()
            raise RuntimeError("Cannot open the selected physical camera. Close other camera apps or select another index.")
        self.camera.set(cv2.CAP_PROP_FRAME_WIDTH,width)
        self.camera.set(cv2.CAP_PROP_FRAME_HEIGHT,height)
        self.camera.set(cv2.CAP_PROP_FPS,fps)
        self.lock=threading.Lock();self.available=threading.Event();self.stop=threading.Event()
        self.latest=None;self.sequence=0;self.error=None
        self.thread=threading.Thread(target=self.capture,daemon=True)
        self.thread.start()

    def capture(self):
        try:
            while not self.stop.is_set():
                ok,frame=self.camera.read()
                if not ok:
                    self.error="Camera stopped producing frames.";self.available.set();return
                with self.lock:
                    self.sequence+=1;self.latest=(self.sequence,frame,time.perf_counter())
                self.available.set()
        finally:
            self.camera.release()

    def next(self,previous):
        deadline=time.perf_counter()+3
        while time.perf_counter()<deadline and not self.stop.is_set():
            self.available.wait(.1);self.available.clear()
            if self.error:
                raise RuntimeError(self.error)
            with self.lock:
                if self.latest and self.latest[0]!=previous:
                    return self.latest
        raise RuntimeError("Camera frame timeout.")

    def close(self):
        self.stop.set();self.thread.join(2)


def commands(channel,stop_on_eof):
    for line in sys.stdin:
        try:
            command=json.loads(line)
            channel.put_nowait(command)
        except (ValueError,queue.Full):
            emit("error",message="Invalid or excessive camera commands.")
    if stop_on_eof:channel.put({"command":"stop"})


def sessions(directory,device):
    if "DmlExecutionProvider" not in ort.get_available_providers():
        raise RuntimeError("DirectML is unavailable in the camera runtime.")
    result={}
    for side in ["L","R"]:
        options=ort.SessionOptions();options.enable_mem_pattern=False
        options.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL;options.intra_op_num_threads=1
        result[side]=ort.InferenceSession(str(directory/f"flx-{side.lower()}.onnx"),sess_options=options,providers=[("DmlExecutionProvider",{"device_id":device})])
    return result


def run(args):
    device=next((a for a in adapters() if a["index"]==args.device and not a["software"]),None)
    if device is None:
        raise RuntimeError("Select a hardware DirectML GPU index.")
    cameras=list(enumerate_cameras(cv2.CAP_DSHOW))
    if args.camera is None:
        args.camera=next((c.index for c in cameras if "obs virtual camera" not in c.name.lower()),None)
    selected=next((c for c in cameras if c.index==args.camera),None)
    if selected is None:
        raise RuntimeError("No input camera is connected. Connect a webcam or phone camera and refresh the camera list.")
    if "obs virtual camera" in selected.name.lower():
        raise RuntimeError("OBS Virtual Camera is the output. Choose a separate input camera to avoid a feedback loop.")
    corrector=Corrector(sessions(args.models,args.device),args.strength)
    options=mp.tasks.vision.FaceLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(args.models/"face_landmarker.task")),
        running_mode=mp.tasks.vision.RunningMode.VIDEO,num_faces=1,
        min_face_detection_confidence=.6,min_face_presence_confidence=.6,min_tracking_confidence=.6,
        output_face_blendshapes=True,output_facial_transformation_matrixes=True)
    capture=None;virtual=None;landmarker=None
    control=queue.Queue(32)
    threading.Thread(target=commands,args=(control,args.duration<=0),daemon=True).start()
    started=time.perf_counter();last_stats=started;last_preview=0;previous=0;timestamp=-1
    frames=0;skipped=0;timings=[];total_frames=0;total_faces=0;total_corrected=0
    try:
        landmarker=mp.tasks.vision.FaceLandmarker.create_from_options(options)
        capture=LatestFrame(args.camera,args.width,args.height,args.fps)
        previous,frame,captured=capture.next(previous)
        height,width=frame.shape[:2]
        virtual=pyvirtualcam.Camera(width=width,height=height,fps=args.fps,backend="obs",fmt=pyvirtualcam.PixelFormat.RGB)
        emit("ready",device=device,virtualCamera=virtual.device,width=width,height=height,camera=args.camera,cameraName=selected.name)
        while args.duration<=0 or time.perf_counter()-started<args.duration:
            while not control.empty():
                command=control.get_nowait()
                action=command.get("command")
                if action=="stop":
                    return
                if action in ("calibrate_camera","calibrate_notes"):
                    try:corrector.begin_calibration(action.split("_")[1])
                    except ValueError as error:emit("error",message=str(error))
                elif action=="configure":
                    strength=command.get("strength",corrector.max_vertical)
                    if not isinstance(strength,(float,int)) or not np.isfinite(strength) or not 0<=strength<=15:
                        emit("error",message="Correction strength must be from 0 to 15 degrees.")
                    else:
                        corrector.max_vertical=float(strength);corrector.enabled=bool(command.get("enabled",True))
            processed_at=time.perf_counter()
            timestamp=max(timestamp+1,int((captured-started)*1000))
            rgb=cv2.cvtColor(frame,cv2.COLOR_BGR2RGB)
            detected=landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB,data=rgb),timestamp)
            current=None;blinks={}
            if detected.face_landmarks:
                matrix=detected.facial_transformation_matrixes[0] if detected.facial_transformation_matrixes else None
                current=observation(detected.face_landmarks[0],width,height,matrix)
                if detected.face_blendshapes:
                    values={s.category_name:s.score for s in detected.face_blendshapes[0]}
                    blinks={"L":values.get("eyeBlinkLeft",0),"R":values.get("eyeBlinkRight",0)}
            corrected,state=corrector.apply(frame,current,blinks=blinks)
            virtual.send(cv2.cvtColor(corrected,cv2.COLOR_BGR2RGB))
            now=time.perf_counter();frames+=1;total_frames+=1;total_faces+=int(state["face"]);total_corrected+=int(state["correcting"])
            timings.append((now-captured)*1000)
            if now-last_stats>=1:
                emit("state",**state,fps=frames/(now-last_stats),frameAgeMs=float(np.median(timings)),frameAgeP95Ms=float(np.percentile(timings,95)),processingMs=(now-processed_at)*1000,skippedFrames=skipped)
                frames=0;timings=[];last_stats=now
            if args.preview and now-last_preview>=.3:
                preview=cv2.resize(corrected,(640,round(height*640/width)))
                ok,jpeg=cv2.imencode(".jpg",preview,[cv2.IMWRITE_JPEG_QUALITY,75])
                if ok:emit("preview",image="data:image/jpeg;base64,"+base64.b64encode(jpeg).decode("ascii"))
                last_preview=now
            next_sequence,frame,captured=capture.next(previous)
            skipped+=max(0,next_sequence-previous-1);previous=next_sequence
    finally:
        if capture:capture.close()
        if virtual:virtual.close()
        if landmarker:landmarker.close()
        emit("stopped",frames=total_frames,faceFrames=total_faces,correctedFrames=total_corrected,elapsedMs=(time.perf_counter()-started)*1000)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models",type=Path,default=Path("models/gaze"))
    parser.add_argument("--device",type=int,default=1)
    parser.add_argument("--camera",type=int)
    parser.add_argument("--list-devices",action="store_true")
    parser.add_argument("--width",type=int,default=1280);parser.add_argument("--height",type=int,default=720)
    parser.add_argument("--fps",type=int,default=30);parser.add_argument("--strength",type=float,default=12)
    parser.add_argument("--duration",type=float,default=0);parser.add_argument("--preview",action="store_true")
    args=parser.parse_args()
    if args.list_devices:
        emit("devices",cameras=[{"index":c.index,"name":c.name,"allowed":"obs virtual camera" not in c.name.lower()} for c in enumerate_cameras(cv2.CAP_DSHOW)],gpus=[a for a in adapters() if not a["software"]])
        return 0
    if args.device<0 or (args.camera is not None and args.camera<0) or not 0<=args.strength<=15 or not 1<=args.fps<=60:
        parser.error("Invalid camera, GPU, strength or FPS")
    try:run(args)
    except Exception as error:
        emit("error",message=str(error));return 1
    return 0


if __name__=="__main__":
    raise SystemExit(main())
