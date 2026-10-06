import unittest
import numpy as np
from gaze_core import Corrector,Eye,Observation,blend_eye,eye_input


class Prediction:
    def __init__(self):self.angles=[]
    def run(self,_,inputs):
        self.angles.append(inputs["inputs/input_ang:0"].copy())
        return [np.ones((1,48,64,3),np.float32)]


def eye(cx,cy,open=True):
    points=np.array([(cx-20,cy),(cx-12,cy-6),(cx+12,cy-6),(cx+20,cy),(cx+12,cy+6),(cx-12,cy+6)],np.float32)
    return Eye(points,np.array([cx,cy+2],np.float32),.3 if open else .08,np.array([.05,0],np.float32))


def observed(vertical=.05,horizontal=0,blink=False):
    return Observation({"L":eye(160,100,not blink),"R":eye(70,100,not blink)},np.array([vertical,horizontal],np.float32),np.zeros(3,np.float32))


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.models={side:Prediction() for side in ["L","R"]}
        self.corrector=Corrector(self.models)
        self.frame=np.random.default_rng(9070).integers(0,255,(200,240,3),dtype=np.uint8)

    def calibrated(self):
        self.corrector.camera=np.array([0,0,0,0,0],np.float32)
        self.corrector.notes=np.array([.05,0,0,0,0],np.float32)

    def test_unconfigured_lost_face_and_zero_correction_are_byte_exact(self):
        for current in [None,observed()]:
            output,_=self.corrector.apply(self.frame,current,1)
            np.testing.assert_array_equal(output,self.frame)
        self.calibrated()
        output,_=self.corrector.apply(self.frame,observed(0),2)
        np.testing.assert_array_equal(output,self.frame)
        self.assertFalse(self.models["L"].angles)

    def test_eye_blends_preserve_every_other_pixel_and_crop_edges(self):
        bounds=eye_input(self.frame,eye(160,100),"L")[2]
        output=self.frame.copy();blend_eye(output,np.ones((48,64,3),np.float32),bounds,eye(160,100))
        x0,y0,x1,y1=bounds
        outside=np.ones(self.frame.shape[:2],bool);outside[y0+2:y1-2,x0+2:x1-2]=False
        np.testing.assert_array_equal(output[outside],self.frame[outside])
        self.assertTrue(np.any(output!=self.frame))

    def test_blinks_bypass_models_immediately(self):
        self.calibrated()
        output,state=self.corrector.apply(self.frame,observed(blink=True),1)
        np.testing.assert_array_equal(output,self.frame)
        self.assertFalse(state["correcting"])
        output,_=self.corrector.apply(self.frame,observed(),2,blinks={"L":1,"R":1})
        np.testing.assert_array_equal(output,self.frame)
        self.assertFalse(self.models["L"].angles)

    def test_angles_are_bounded_and_large_turns_pass_through(self):
        self.calibrated();self.corrector.max_vertical=15
        output,state=self.corrector.apply(self.frame,observed(.055,.08),1)
        self.assertTrue(state["correcting"])
        self.assertEqual(state["vertical"],15)
        self.assertEqual(state["horizontal"],-3)
        self.assertTrue(np.any(output!=self.frame))
        turned=observed();turned.pose[1]=30
        output,state=self.corrector.apply(self.frame,turned,2)
        np.testing.assert_array_equal(output,self.frame)
        self.assertFalse(state["correcting"])

    def test_calibration_requires_downward_notes_and_stable_visible_eyes(self):
        self.corrector.begin_calibration("camera",0)
        for i in range(20):self.corrector.apply(self.frame,observed(0),i*.08)
        self.assertIsNotNone(self.corrector.camera)
        self.corrector.begin_calibration("notes",2)
        for i in range(20):self.corrector.apply(self.frame,observed(-.05),2+i*.08)
        self.assertIsNone(self.corrector.notes)
        self.corrector.begin_calibration("notes",4)
        for i in range(19):self.corrector.apply(self.frame,observed(.05),4+i*.08)
        self.assertFalse(any(m.angles for m in self.models.values()))
        self.corrector.apply(self.frame,observed(.05),5.52)
        self.assertIsNotNone(self.corrector.notes)

    def test_partial_crops_are_rejected(self):
        self.assertIsNone(eye_input(self.frame,eye(10,100),"R"))

    def test_calibration_rejects_missing_closed_sparse_or_moving_eyes(self):
        scenarios=[
            [None]*20,
            [observed(blink=True) for _ in range(20)],
            [observed(0) for _ in range(9)]+[None]*11,
            [observed(.05 if i%2 else -.05) for i in range(20)],
        ]
        for samples in scenarios:
            with self.subTest(kind=str(samples[0])):
                corrector=Corrector(self.models)
                corrector.begin_calibration("camera",0)
                for i,current in enumerate(samples):
                    output,_=corrector.apply(self.frame,current,i*.08)
                    np.testing.assert_array_equal(output,self.frame)
                self.assertIsNone(corrector.camera)
                self.assertIsNone(corrector.collecting)
                self.assertFalse(any(model.angles for model in self.models.values()))

    def test_crop_center_matches_original_flx_corner_geometry(self):
        current=eye(160,100)
        current.points[1:3,1]-=9
        current.points[4:,1]-=3
        _,_,bounds=eye_input(self.frame,current,"L")
        # Corner midpoint (160,100), width 60 and height 45 with 7/12 above.
        self.assertEqual(bounds,(130,73,190,118))
    def test_model_color_order_matches_original_rgb_training(self):
        frame=np.zeros_like(self.frame);frame[...,2]=255
        image,_,bounds=eye_input(frame,eye(160,100),"L")
        np.testing.assert_array_equal(image[0,20,20],[1,0,0])
        prediction=np.zeros((48,64,3),np.float32);prediction[...,0]=1
        output=np.zeros_like(frame);blend_eye(output,prediction,bounds,eye(160,100))
        np.testing.assert_array_equal(output[100,160],[0,0,255])


if __name__=="__main__":unittest.main()
