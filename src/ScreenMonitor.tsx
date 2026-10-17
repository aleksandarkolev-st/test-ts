import { useEffect, useState } from 'react';
import { command, errorText } from './bridge';
import type { KeyboardBridgeStatus, Settings } from './state/model';
export default function ScreenMonitor({ settings, setSettings, disabled, onError }: {
  settings: Settings;
  setSettings: (update: (settings: Settings) => Settings) => void;
  disabled: boolean;
  onError: (error: string) => void;
}) {
  const enabled = settings.screenMonitorEnabled ?? false;
  const typing = settings.screenMonitorTyping ?? true;
  const [bridge, setBridge] = useState<KeyboardBridgeStatus>();
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    try { setBridge(await command<KeyboardBridgeStatus>('keyboard_bridge_status')); }
    catch (error) { onError(errorText(error)); }
    finally { setChecking(false); }
  };
  useEffect(() => { if (enabled && typing) void check(); }, [enabled, typing]);
  return <section className="device-section screen-monitor"><h2>Screen monitor</h2><p className="section-intro">Optional: your copilot can read your screen during meetings and prepare an answer for it. Nothing is captured or typed unless you turn this on.</p>
    <fieldset disabled={disabled}>
      <label className="monitor-toggle"><input type="checkbox" aria-label="Watch my screen during meetings" checked={enabled} onChange={e => setSettings(s => ({ ...s, screenMonitorEnabled: e.target.checked }))} />Watch my screen during meetings</label>
      {enabled && <>
        <label>Check every (2–300 seconds)<input aria-label="Screen check interval" type="number" min={2} max={300} value={settings.screenMonitorIntervalSeconds ?? 5} onChange={e => setSettings(s => ({ ...s, screenMonitorIntervalSeconds: Number(e.target.value) }))} /></label>
        <p className="field-note">The screen in front of you is captured on that period, including everything visible on that monitor. Capture pauses while this setup window is in front.</p>
        <label className="monitor-toggle"><input type="checkbox" aria-label="Type prepared answers with my keyboard" checked={typing} onChange={e => setSettings(s => ({ ...s, screenMonitorTyping: e.target.checked }))} />Type prepared answers with my keyboard</label>
        <label>Typing speed<select aria-label="Typing speed" value={settings.screenMonitorSpeed ?? 'normal'} disabled={!typing} onChange={e => setSettings(s => ({ ...s, screenMonitorSpeed: e.target.value as Settings['screenMonitorSpeed'] }))}><option value="slow">Slow</option><option value="normal">Normal</option><option value="fast">Fast</option></select></label>
        <p className="field-note">Typing is automated keyboard input sent by this app through your keyboard’s screen-typing firmware. It begins only after you focus the answer field in the watched app, and it types just the cached answer text with no extra explanation.</p>
      </>}
    </fieldset>
    {enabled && typing && <div className={`monitor-bridge ${!bridge ? '' : bridge.connected ? 'ok' : 'warn'}`} role="status">
      {!bridge ? 'Checking the keyboard…' : bridge.connected ? `Keyboard ready · ${bridge.product || 'screen-typing firmware connected'}` : bridge.detail}
      <button className="text-button" type="button" disabled={checking} onClick={check}>{checking ? 'Checking…' : 'Check keyboard'}</button>
    </div>}
    {enabled && typing && <p className="field-note">If the keyboard cannot be reached, nothing is typed and the overlay shows a warning instead. Ctrl Shift F12 stops typing at any time.</p>}
  </section>;
}
