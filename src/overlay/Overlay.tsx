import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { command, connectState, errorText, native } from '../bridge';
import { useMeeting } from '../state/store';
import Status from './Status';
import Answer from './Answer';
import ContextAttachments from '../ContextAttachments';
import Icon from '../ui/Icon';
export default function Overlay() {
  const s = useMeeting(v => v.snapshot); const ref = useRef<HTMLDivElement>(null); const input = useRef<HTMLInputElement>(null);
  const [question, setQuestion] = useState(''); const [error, setError] = useState('');
  useEffect(() => { if (!s.active || !s.manual) setQuestion(''); if (!s.active) setError(''); }, [s.active, s.manual]);
  useEffect(() => { let off: (() => void) | undefined; let disposed = false; connectState().then(f => { if (disposed) f(); else off = f; }).catch(e => setError(errorText(e))); return () => { disposed = true; off?.(); }; }, []);
  useEffect(() => { if (!ref.current || !native()) return; let timer: ReturnType<typeof setTimeout>; const obs = new ResizeObserver(([e]) => { clearTimeout(timer); timer = setTimeout(() => command('resize_overlay', { height: Math.ceil(e.contentRect.height) + 4 }).catch(e => setError(errorText(e))), 50); }); obs.observe(ref.current); return () => { obs.disconnect(); clearTimeout(timer); }; }, []);
  useEffect(() => { if (s.manual) input.current?.focus(); }, [s.manual]);
  const candidateId = s.questions?.filter(q => q.state === 'speculative').at(-1)?.id;
  const act = (action: string) => command('action', { action, ...(action === 'expand' ? { generationId: s.question?.id } : action === 'answer_now' ? { generationId: candidateId } : {}) }).catch(e => setError(errorText(e)));
  return <div className={`overlay ${s.expanded ? 'expanded' : ''}`} ref={ref}>
    <header className="overlay-header"><div onPointerDown={e => { if (e.button === 0 && native()) getCurrentWindow().startDragging(); }} className="drag-handle"><span className="overlay-wordmark" aria-hidden="true">m</span><Status snapshot={s} /></div><button title="Hide overlay · Ctrl Shift H" onClick={() => act('hide')}>Hide <Icon name="hide" /></button></header>
    <Answer snapshot={s} />
    {s.answer&&<details className="scroll-hint"><summary>Reading shortcuts <kbd>Ctrl Shift ↑ / ↓</kbd></summary><p>Page up / down <kbd>Ctrl Shift Page Up / Down</kbd><br/>Top / bottom <kbd>Ctrl Shift Home / End</kbd><br/>Code left / right <kbd>Ctrl Shift ← / →</kbd><br/>Move window <kbd>Ctrl Alt ← ↑ → ↓</kbd></p></details>}
    <div className="overlay-tools">
    <ContextAttachments snapshot={s} onError={setError} />
    <div className="context-actions"><button disabled={!s.active || s.attachmentBusy} title="Send screenshot · Ctrl Shift F8" onClick={() => act('screenshot')}><Icon name="screen"/> Screenshot <kbd>F8</kbd></button><button disabled={!s.active || s.attachmentBusy} title="Send active context · Ctrl Shift P" onClick={() => act('context')}><Icon name="folder"/> Active context <kbd>P</kbd></button><span>Ctrl Shift</span></div>
    {s.manual && <form className="manual-form" onSubmit={async e => { e.preventDefault(); try { await command('ask', { question }); setQuestion(''); setError(''); } catch (e) { setError(errorText(e)); } }}><label htmlFor="manual-question">Ask about this meeting…</label><div className="ask-row"><input ref={input} id="manual-question" value={question} maxLength={4000} onChange={e => setQuestion(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') act('dismiss'); }} placeholder="What did they say the launch date was?" /><button disabled={!question.trim()}>Ask</button></div></form>}
    {error && <div role="alert" className="error">{error}</div>}
    </div>
    <footer className="overlay-footer"><span className={s.protection ? 'protected' : 'unprotected'}><Icon name="shield"/>{s.protection ? 'Share protection active' : 'Share protection unavailable'}</span><div>{s.question && <button disabled={!s.answer.trim()} title="Expand · Ctrl Shift E" onClick={() => act('expand')}>More</button>}{s.active && <button disabled={!s.canAnswerNow || !candidateId} title="Accept current finalized speech without waiting" onClick={() => act('answer_now')}>Answer now</button>}<button className="primary" title="Ask · Ctrl Shift Space" onClick={() => act('manual')}>Ask</button>{(s.question || s.error || s.manual) && <button title="Dismiss · Ctrl Shift X" aria-label="Dismiss answer" onClick={() => act('dismiss')}><Icon name="close"/></button>}</div></footer>
  </div>;
}
