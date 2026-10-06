import json,sys
from pathlib import Path
from PIL import Image,ImageChops,ImageStat
root=Path(sys.argv[1]);g=json.loads((root/'geometry.json').read_text());r=g['rect']
control=Image.open(root/'obs-display-control.png').convert('RGB')
protected=Image.open(root/'obs-display-protected.png').convert('RGB')
sx=control.width/g['screen']['width'];sy=control.height/g['screen']['height']
box=(int((r['left']+25)*sx),int((r['top']+25)*sy),int((r['right']-25)*sx),int((r['bottom']-25)*sy))
c=control.crop(box);p=protected.crop(box)
green=(21,180,85)
green_distance=sum(ImageStat.Stat(ImageChops.difference(p,Image.new('RGB',p.size,green))).mean)/3
display_change=sum(ImageStat.Stat(ImageChops.difference(c,p)).mean)/3
w=Image.open(root/'obs-window-control.png').convert('RGB')
refused=json.loads((root/'window-status.json').read_text())['protectedWindowRefused']
control_brightness=sum(ImageStat.Stat(w).mean)/3
window_change=None;window_brightness=None
if not refused:
    wp=Image.open(root/'obs-window-protected.png').convert('RGB')
    window_change=sum(ImageStat.Stat(ImageChops.difference(w,wp)).mean)/3
    window_brightness=sum(ImageStat.Stat(wp).mean)/3
metrics=dict(displayControlChange=display_change,protectedBackgroundError=green_distance,windowControlBrightness=control_brightness,windowControlChange=window_change,protectedWindowBrightness=window_brightness,protectedWindowRefused=refused)
print(json.dumps(metrics))
assert display_change>10, 'Display positive control did not show the overlay'
assert green_distance<5, 'Protected overlay pixels remain in OBS Display Capture'
assert control_brightness>10, 'Window positive control did not show the overlay'
if not refused:
    assert window_change>5, 'Window positive control did not differ from protected capture'
    assert window_brightness<5, 'Protected window remains visible in OBS Window Capture'
