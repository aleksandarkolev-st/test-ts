// Stateful windowed-sinc resampling. Keeps phase across WASAPI packet boundaries
// and low-pass filters before downsampling to prevent high-frequency aliasing.
pub struct Resampler {
    rate: f64,
    input: Vec<f32>,
    position: f64,
}
impl Resampler {
    pub fn new(rate: u32) -> Self {
        Self {
            rate: rate as f64,
            input: vec![0.; 32],
            position: 16.,
        }
    }
    pub fn process(&mut self, mono: &[f32]) -> Vec<f32> {
        self.input.extend_from_slice(mono);
        let step = self.rate / 16000.;
        let cutoff = (16000. / self.rate).min(1.) * 0.94;
        let mut out = Vec::new();
        while self.position + 16. < self.input.len() as f64 {
            let center = self.position.floor() as isize;
            let mut sum = 0.;
            let mut weights = 0.;
            for i in center - 15..=center + 16 {
                let x = i as f64 - self.position;
                let z = std::f64::consts::PI * x * cutoff;
                let sinc = if z.abs() < 1e-10 { 1. } else { z.sin() / z };
                let window = 0.5 + 0.5 * (std::f64::consts::PI * x / 16.).cos();
                let w = sinc * window * cutoff;
                sum += self.input[i as usize] as f64 * w;
                weights += w;
            }
            out.push((sum / weights) as f32);
            self.position += step;
        }
        let drop = (self.position.floor() as usize).saturating_sub(16);
        self.input.drain(..drop);
        self.position -= drop as f64;
        out
    }
}
pub fn downmix(samples: &[f32], channels: usize) -> Vec<f32> {
    samples
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stereo_and_packet_boundaries() {
        assert_eq!(downmix(&[1., -1., 0.5, 0.5], 2), vec![0., 0.5]);
        let samples: Vec<_> = (0..48000).map(|i| (i as f32 * 0.1).sin()).collect();
        let a = Resampler::new(48000).process(&samples);
        let mut r = Resampler::new(48000);
        let b: Vec<_> = samples.chunks(113).flat_map(|s| r.process(s)).collect();
        assert_eq!(a, b);
        assert!((a.len() as i32 - 16000).abs() < 10);
    }
    #[test]
    fn rejects_out_of_band_alias() {
        let x: Vec<_> = (0..48000)
            .map(|i| (2. * std::f32::consts::PI * 12000. * i as f32 / 48000.).sin())
            .collect();
        let y = Resampler::new(48000).process(&x);
        let rms = (y[100..].iter().map(|x| x * x).sum::<f32>() / (y.len() - 100) as f32).sqrt();
        assert!(rms < 0.02, "{rms}");
    }
}
