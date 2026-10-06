"""Check real OBS output frames without retaining or logging image content."""
import json
import time
import cv2
from cv2_enumerate_cameras import enumerate_cameras

camera_info=next((c for c in enumerate_cameras(cv2.CAP_DSHOW) if "obs virtual camera" in c.name.lower()),None)
if camera_info is None:raise RuntimeError("OBS Virtual Camera is not installed")
camera=cv2.VideoCapture(camera_info.index,cv2.CAP_DSHOW)
camera.set(cv2.CAP_PROP_FRAME_WIDTH,1280)
camera.set(cv2.CAP_PROP_FRAME_HEIGHT,720)
camera.set(cv2.CAP_PROP_FPS,30)
try:
    frames=[]
    for _ in range(4):
        ok,frame=camera.read()
        if not ok:raise RuntimeError("OBS output did not supply a frame")
        frames.append((time.perf_counter(),frame.shape))
    print(json.dumps({"name":camera_info.name,"frames":len(frames),"shape":frames[-1][1],"last_interval_ms":(frames[-1][0]-frames[-2][0])*1000}))
finally:camera.release()
