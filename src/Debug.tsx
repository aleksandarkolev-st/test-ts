import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { command, errorText, native } from './bridge';
import type { Bootstrap, TranscriptSegment } from './state/model';
export default function Debug() {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]); const [enabled, setEnabled] = useState(false); const [error, setError] = useState('');
  useEffect(() => { let disposed = false; const disposers: (() => void)[] = [];
    (async () => { if (!native()) return; const b = await command<Bootstrap>('bootstrap'); if (!b.debug) return; setEnabled(true); const transcriptOff = await listen<TranscriptSegment>('copilot:transcript', e => setSegments(s => [...s.filter(x => x.id !== e.payload.id), e.payload].slice(-200))); const eventOff = await listen<{ name: string }>('copilot:event', e => { if (e.payload.name === 'meeting.stopped') setSegments([]); }); if (disposed) { transcriptOff(); eventOff(); } else disposers.push(transcriptOff, eventOff); })().catch(e => setError(errorText(e)));
    return () => { disposed = true; disposers.forEach(f => f()); };
  }, []);
  return <main className="debug"><h1>Local transcript</h1><p>Development only · held in memory · cleared when meeting stops.</p>{error && <p role="alert">{error}</p>}{enabled ? segments.map(s => <p key={s.id}><b>{s.source.toUpperCase()}</b> <small>{(s.endedAt / 1000).toFixed(1)}s</small> {s.text}</p>) : <p>Debug transcription is available in development desktop builds.</p>}</main>;
}
