import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { command, errorText, native } from './bridge';

interface CameraView { running: boolean; loading: boolean; calibrated: boolean; cameraCalibrated: boolean; calibrating: string | null; face: boolean; correcting: boolean; message: string; error: string | null; preview: string | null; device: string; camera: string; fps: number; frameAgeMs: number; frameAgeP95Ms: number; vertical: number; horizontal: number }
interface Devices { cameras: { index: number; name: string; allowed: boolean }[]; gpus: { index: number; name: string; dedicated_video_bytes: number }[] }
const initial: CameraView = { running: false, loading: false, calibrated: false, cameraCalibrated: false, calibrating: null, face: false, correcting: false, message: 'Start the camera to preview and calibrate correction.', error: null, preview: null, device: '', camera: '', fps: 0, frameAgeMs: 0, frameAgeP95Ms: 0, vertical: 0, horizontal: 0 };

export default function Camera() {
  const [view, setView] = useState(initial); const [devices, setDevices] = useState<Devices>({ cameras: [], gpus: [] });
  const [camera, setCamera] = useState<number | null>(null); const [device, setDevice] = useState(1);
  const [strength, setStrength] = useState(12); const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function run(action: () => Promise<unknown>) { setBusy(true); setError(''); try { await action(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }
  async function refresh() {
    const d = await command<Devices>('gaze_devices'); setDevices(d);
    setCamera(current => d.cameras.some(c => c.index === current && c.allowed) ? current : d.cameras.find(c => c.allowed)?.index ?? null);
    setDevice(current => d.gpus.some(g => g.index === current) ? current : [...d.gpus].sort((a, b) => b.dedicated_video_bytes - a.dedicated_video_bytes)[0]?.index ?? 0);
  }
  useEffect(() => {
    if (!native()) return;
    let disposed = false; let unlisten: (() => void) | undefined;
    listen<CameraView>('copilot:gaze', event => { if (!disposed) setView(event.payload); }).then(f => { if (disposed) f(); else unlisten = f; }).catch(e => setError(errorText(e)));
    command<CameraView>('gaze_snapshot').then(v => { if (!disposed) setView(v); }).catch(e => setError(errorText(e)));
    refresh().catch(e => setError(errorText(e)));
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const active = view.running || view.loading;
  return <section className="camera-section device-section">
    <div className="section-label">EYE CONTACT</div>
    <p className="field-note">Small eye corrections for reading notes below the camera. Video stays on this device and feeds OBS Virtual Camera.</p>
    <fieldset disabled={busy || active || !native()}>
      <label>Input camera<select aria-label="Input camera" value={camera ?? ''} onChange={e => setCamera(Number(e.target.value))}><option value="" disabled>Choose a camera</option>{devices.cameras.filter(c => c.allowed).map(c => <option key={c.index} value={c.index}>{c.name}</option>)}</select></label>
      <label>Camera GPU<select aria-label="Camera GPU" value={device} onChange={e => setDevice(Number(e.target.value))}>{devices.gpus.map(g => <option key={g.index} value={g.index}>{g.name}</option>)}</select></label>
    </fieldset>
    {!active && <button disabled={busy || !native()} onClick={() => run(refresh)}>Refresh cameras</button>}
    {view.preview && <img className="camera-preview" src={view.preview} alt="Live local gaze-correction preview" />}
    <p className="camera-status" role="status">{view.loading ? 'Opening local camera…' : view.running ? `${view.correcting ? 'Correcting eye gaze' : view.face ? 'Eye correction on standby' : 'No face detected · original video'} · ${Math.round(view.fps)} fps` : 'Camera off'}</p>
    <p className="field-note">{view.message}</p>
    {view.running && view.fps > 0 && view.fps < 15 && <p className="field-note">The input camera is supplying fewer than 15 fps. Connect or enable its video source for a smooth call preview.</p>}
    {view.running && <>
      <div className="button-row"><button disabled={busy || !view.face || !!view.calibrating} onClick={() => run(() => command('gaze_control', { action: 'calibrate_camera', strength: null, enabled: null }))}>Calibrate looking at camera</button><button disabled={busy || !view.face || !view.cameraCalibrated || !!view.calibrating} onClick={() => run(() => command('gaze_control', { action: 'calibrate_notes', strength: null, enabled: null }))}>Calibrate looking at notes</button></div>
      <p className="field-note">Hold each gaze for about two seconds. Keep your head near its normal call position. Closed eyes, large turns and gaze outside the notes range pass through.</p>
      <label>Maximum correction · {strength}°<input aria-label="Maximum correction" type="range" min="0" max="15" step="1" value={strength} onChange={e => { const value = Number(e.target.value); setStrength(value); command('gaze_control', { action: 'configure', strength: value, enabled }).catch(e => setError(errorText(e))); }} /></label>
      <label className="camera-toggle"><input type="checkbox" checked={enabled} onChange={e => { setEnabled(e.target.checked); command('gaze_control', { action: 'configure', strength, enabled: e.target.checked }).catch(e => setError(errorText(e))); }} />Enable correction after calibration</label>
      <p className="field-note">{view.camera} · {view.device} · captured frame to output {view.frameAgeMs.toFixed(1)} ms median / {view.frameAgeP95Ms.toFixed(1)} ms p95. This excludes delay inside the camera or meeting app.</p>
      <p className="field-note">Select <strong>OBS Virtual Camera</strong> as the camera in your call. Start around 10–12° and adjust using the preview.</p>
    </>}
    {(error || view.error) && <p className="error" role="alert">{error || view.error}</p>}
    {active ? <button disabled={busy} onClick={() => run(() => command('gaze_stop'))}>Stop camera</button> : <button disabled={busy || !native() || camera === null || !devices.gpus.length} onClick={() => run(async () => { setEnabled(true); await command('gaze_start', { settings: { camera, device, strength } }); })}>Start camera preview</button>}
  </section>;
}
