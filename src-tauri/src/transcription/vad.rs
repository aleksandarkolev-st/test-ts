const FRAME: usize = 480;
const SILENCE_FRAMES: usize = 17; // 510ms
const PREVIEW_SILENCE_FRAMES: usize = 5; // 150ms; inference only, not end confirmation
const MIN_VOICED: usize = 3;
const MAX_SAMPLES: usize = 16000 * 15;
#[derive(Debug)]
pub enum VadEvent {
    Started(u64),
    Ended(u64),
    Activity { quiet: bool, timestamp: u64 },
    Preview {
        samples: Vec<f32>,
        started: u64,
        ended: u64,
    },
    Chunk {
        samples: Vec<f32>,
        started: u64,
        ended: u64,
        final_: bool,
    },
}
pub struct Vad {
    pending: Vec<f32>,
    pre: Vec<f32>,
    speech: Vec<f32>,
    active: bool,
    silent: usize,
    voiced: usize,
    start: u64,
    last_voice: u64,
    frame_time: Option<u64>,
    noise: f32,
    last_partial: u64,
    preview_sent: bool,
    quiet_sent: bool,
}
impl Default for Vad {
    fn default() -> Self {
        Self {
            pending: vec![],
            pre: vec![],
            speech: vec![],
            active: false,
            silent: 0,
            voiced: 0,
            start: 0,
            last_voice: 0,
            frame_time: None,
            noise: 0.001,
            last_partial: 0,
            preview_sent: false,
            quiet_sent: false,
        }
    }
}
impl Vad {
    pub fn process(&mut self, samples: &[f32], timestamp: u64) -> Vec<VadEvent> {
        // Capture timestamps own the clock. Counting samples forever drifts
        // when WASAPI resumes after injected silence or packet gaps, which can
        // put VAD end beyond the recognizer's final audio and stall confirmation.
        self.frame_time = Some(timestamp.saturating_sub((self.pending.len()/16) as u64));
        self.pending.extend_from_slice(samples);
        let mut events = vec![];
        while self.pending.len() >= FRAME {
            let f: Vec<_> = self.pending.drain(..FRAME).collect();
            let t = self.frame_time.unwrap();
            self.frame_time = Some(t + 30);
            let rms = (f.iter().map(|x| x * x).sum::<f32>() / FRAME as f32).sqrt();
            let voiced = rms > 0.008_f32.max(self.noise * 3.5);
            if !self.active && !voiced {
                self.noise = (self.noise * 0.98 + rms * 0.02).min(0.004);
            }
            if voiced {
                self.voiced += 1;
            } else if !self.active {
                self.voiced = 0;
            }
            if !self.active {
                self.pre.extend_from_slice(&f);
                if self.pre.len() > FRAME * 10 {
                    self.pre.drain(..FRAME);
                }
                if self.voiced >= MIN_VOICED {
                    self.active = true;
                    self.preview_sent = false;
                    self.quiet_sent = false;
                    self.last_partial = t;
                    self.start = t.saturating_sub((self.pre.len() / 16) as u64);
                    self.speech = std::mem::take(&mut self.pre);
                    events.push(VadEvent::Started(self.start));
                } else {
                    continue;
                }
            } else {
                self.speech.extend_from_slice(&f);
            }
            if voiced {
                if self.quiet_sent {
                    events.push(VadEvent::Activity { quiet: false, timestamp: t });
                    self.quiet_sent = false;
                }
                self.last_voice = t + 30;
                self.silent = 0;
            } else {
                self.silent += 1;
            }
            if self.silent >= PREVIEW_SILENCE_FRAMES && !self.quiet_sent {
                self.quiet_sent = true;
                events.push(VadEvent::Activity { quiet: true, timestamp: self.last_voice });
            }
            if self.silent >= SILENCE_FRAMES {
                events.push(VadEvent::Ended(self.last_voice));
                events.push(VadEvent::Chunk {
                    samples: std::mem::take(&mut self.speech),
                    started: self.start,
                    ended: self.last_voice,
                    final_: true,
                });
                self.active = false;
                self.voiced = 0;
                self.silent = 0;
            } else if self.speech.len() >= MAX_SAMPLES {
                events.push(VadEvent::Chunk {
                    samples: std::mem::take(&mut self.speech),
                    started: self.start,
                    ended: t + 30,
                    final_: true,
                });
                self.start = t + 30;
                self.last_partial = t;
                self.preview_sent = false;
            } else if self.silent >= PREVIEW_SILENCE_FRAMES
                && !self.preview_sent
                && self.last_voice > self.start
                && f.iter().all(|sample| sample.to_bits() == 0)
            {
                // Compute while the existing 510ms end wait runs. Assume only
                // zero samples for the remaining silence; the worker may reuse
                // this result only if the later final audio matches exactly.
                let mut samples = self.speech.clone();
                samples.resize(samples.len() + (SILENCE_FRAMES - self.silent) * FRAME, 0.);
                events.push(VadEvent::Preview {
                    samples,
                    started: self.start,
                    ended: self.last_voice,
                });
                // At most one speculative inference per bounded speech chunk.
                self.preview_sent = true;
            } else if t.saturating_sub(self.last_partial) >= 2000 && voiced {
                events.push(VadEvent::Chunk {
                    samples: self.speech.clone(),
                    started: self.start,
                    ended: self.last_voice,
                    final_: false,
                });
                self.last_partial = t;
            }
        }
        events
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acoustic_pause_is_provisional_and_retracted_on_the_first_voiced_frame() {
        let mut v=Vad::default();
        v.process(&vec![0.1;FRAME*20],0);
        // Quiet can contain background noise; this is independent of the
        // exact-zero optimization used by the batch-transcription preview.
        let quiet=v.process(&vec![0.001;FRAME*5],600);
        assert_eq!(quiet.iter().filter(|e|matches!(e,VadEvent::Activity{quiet:true,timestamp:600})).count(),1);
        assert!(!quiet.iter().any(|e|matches!(e,VadEvent::Ended(_))));
        assert!(!v.process(&vec![0.001;FRAME*3],750).iter().any(|e|matches!(e,VadEvent::Activity{quiet:true,..})));
        let resumed=v.process(&vec![0.1;FRAME],840);
        assert!(resumed.iter().any(|e|matches!(e,VadEvent::Activity{quiet:false,timestamp:840})));
        let next=v.process(&vec![0.001;FRAME*5],870);
        assert!(next.iter().any(|e|matches!(e,VadEvent::Activity{quiet:true,timestamp:870})));
    }
    #[test]
    fn capture_clock_changes_do_not_leave_the_end_ahead_of_final_audio() {
        let mut vad=Vad::default();
        vad.process(&vec![0.;FRAME*100],0);
        // A resumed packet is timestamped earlier than the sample-count cursor.
        vad.process(&vec![0.1;FRAME*20],2000);
        let events=vad.process(&vec![0.;FRAME*SILENCE_FRAMES],2600);
        assert!(events.iter().any(|e|matches!(e,VadEvent::Ended(2600))));
        let mut vad=Vad::default();
        vad.process(&vec![0.;FRAME*10],0);
        // A packet gap must not timestamp new speech at the old cursor.
        let events=vad.process(&vec![0.1;FRAME*20],5000);
        assert!(events.iter().any(|e|matches!(e,VadEvent::Started(t) if *t>=4700)));
        let events=vad.process(&vec![0.;FRAME*SILENCE_FRAMES],5600);
        assert!(events.iter().any(|e|matches!(e,VadEvent::Ended(5600))));
    }
    #[test]
    fn skips_silence_and_detects_end_within_target() {
        let mut v = Vad::default();
        assert!(v.process(&vec![0.; 16000], 0).is_empty());
        let speech = vec![0.1; 16000];
        assert!(v
            .process(&speech, 1000)
            .iter()
            .any(|e| matches!(e, VadEvent::Started(_))));
        let e = v.process(&vec![0.; 9600], 2000);
        assert!(e
            .iter()
            .any(|e| matches!(e,VadEvent::Ended(t) if *t>=1980&&*t<=2040)));
        assert!(e
            .iter()
            .any(|e| matches!(e, VadEvent::Chunk { final_: true, .. })));
    }
    #[test]
    fn bounds_long_speech() {
        let mut v = Vad::default();
        let e = v.process(&vec![0.1; 16000 * 60], 0);
        assert!(
            e.iter()
                .filter(|e| matches!(e, VadEvent::Chunk { .. }))
                .count()
                >= 3
        );
        assert!(v.speech.len() < MAX_SAMPLES);
    }
    #[test]
    fn preview_does_not_confirm_end_and_matches_only_unchanged_zero_tail() {
        let mut vad = Vad::default();
        vad.process(&vec![0.1; FRAME * 20], 0);
        let preview = vad.process(&vec![0.; FRAME * PREVIEW_SILENCE_FRAMES], 600);
        assert!(!preview.iter().any(|e| matches!(e, VadEvent::Ended(_))));
        let expected = preview
            .into_iter()
            .find_map(|e| match e {
                VadEvent::Preview {
                    samples,
                    started,
                    ended,
                } => Some((samples, started, ended)),
                _ => None,
            })
            .unwrap();
        let final_events = vad.process(
            &vec![0.; FRAME * (SILENCE_FRAMES - PREVIEW_SILENCE_FRAMES)],
            750,
        );
        assert!(final_events
            .iter()
            .any(|e| matches!(e, VadEvent::Ended(600))));
        let actual = final_events
            .into_iter()
            .find_map(|e| match e {
                VadEvent::Chunk {
                    samples,
                    started,
                    ended,
                    final_: true,
                } => Some((samples, started, ended)),
                _ => None,
            })
            .unwrap();
        assert_eq!(expected, actual);
    }
    #[test]
    fn continued_speech_invalidates_preview_and_does_not_repeat_speculation() {
        let mut vad = Vad::default();
        vad.process(&vec![0.1; FRAME * 20], 0);
        let preview = vad.process(&vec![0.; FRAME * PREVIEW_SILENCE_FRAMES], 600);
        let predicted = preview
            .into_iter()
            .find_map(|e| match e {
                VadEvent::Preview { samples, .. } => Some(samples),
                _ => None,
            })
            .unwrap();
        vad.process(&vec![0.1; FRAME * 10], 750);
        let events = vad.process(&vec![0.; FRAME * SILENCE_FRAMES], 1050);
        assert!(!events.iter().any(|e| matches!(e, VadEvent::Preview { .. })));
        let final_samples = events
            .into_iter()
            .find_map(|e| match e {
                VadEvent::Chunk {
                    samples,
                    final_: true,
                    ..
                } => Some(samples),
                _ => None,
            })
            .unwrap();
        assert_ne!(predicted, final_samples);
    }
    #[test]
    fn noisy_silence_uses_normal_final_without_extra_preview_work() {
        let mut vad = Vad::default();
        vad.process(&vec![0.1; FRAME * 20], 0);
        let events = vad.process(&vec![0.001; FRAME * SILENCE_FRAMES], 600);
        assert!(!events.iter().any(|e| matches!(e, VadEvent::Preview { .. })));
        assert!(events.iter().any(|e| matches!(e, VadEvent::Ended(600))));
        assert!(events
            .iter()
            .any(|e| matches!(e, VadEvent::Chunk { final_: true, .. })));
    }
}
