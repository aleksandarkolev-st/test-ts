import { useEffect, useState } from 'react';
import { command, connectState, errorText, native } from './bridge';
import { useMeeting } from './state/store';
import type { Account, Bootstrap, Model, Settings } from './state/model';
import Status from './overlay/Status';
import ContextAttachments from './ContextAttachments';
import Camera from './Camera';
const empty: Settings = { microphone: '', output: '', modelPath: '', model: '', speechBackend: 'nemotron', speechChunkMs: 160, nemotronDevice: 1 };
export default function App() {
  const snapshot = useMeeting(s => s.snapshot);
  const [data, setData] = useState<Bootstrap>(); const [settings, setSettings] = useState<Settings>(empty);
  const [models, setModels] = useState<Model[]>([]); const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const [question, setQuestion] = useState('');
  useEffect(() => { if (!snapshot.active) setQuestion(''); }, [snapshot.active]);
  async function refresh() {
    const b = await command<Bootstrap>('bootstrap'); setData(b);
    setSettings({ ...b.settings, microphone: b.settings.microphone || b.devices.find(d => d.source === 'self' && d.default)?.id || '', output: b.settings.output || b.devices.find(d => d.source === 'remote' && d.default)?.id || '' });
    useMeeting.getState().apply(b.snapshot);
    if (b.selected?.planEnabled) {
      const ms = await command<Model[]>('list_models'); setModels(ms);
      setSettings(s => ({ ...s, model: ms.some(m => m.slug === s.model) ? s.model : (s.answerBackend === 'codex' ? ms.find(m => m.slug === 'gpt-6.1-sol')?.slug : null) || ms.find(m => /mini|nano|luna/.test(m.slug) && !/pro/.test(m.slug))?.slug || ms.find(m => /sol/.test(m.slug) && !/pro/.test(m.slug))?.slug || ms[0]?.slug || '' }));
    } else setModels([]);
  }
  useEffect(() => { let dispose: (() => void) | undefined; let disposed = false;
    connectState().then(f => { if (disposed) f(); else dispose = f; }).catch(e => setError(errorText(e)));
    if (native()) refresh().catch(e => setError(errorText(e)));
    return () => { disposed = true; dispose?.(); };
  }, []);
  async function run(label: string, action: () => Promise<unknown>) { setError(''); setBusy(label); try { await action(); } catch (e) { setError(errorText(e)); } finally { setBusy(''); } }
  async function signIn(account?: Account) { await command('sign_in', { clientId: account?.clientId ?? null }); await refresh(); }
  const nemotron = (settings.speechBackend || 'nemotron') === 'nemotron';
  const codex = settings.answerBackend === 'codex';
  const loading = snapshot.status === 'loading';
  const canStart = native() && data?.selected?.planEnabled && settings.microphone && settings.output && settings.modelPath && settings.model && (!nemotron || settings.nemotronRuntime);
  return <main className="setup">
    <header className="brand"><div className="brand-mark" aria-hidden="true">m</div><div><h1>Meeting Copilot</h1><p>A little help, when it’s your turn.</p></div></header>
    {!native() && <div className="notice">This app captures audio and protects its overlay through Windows. Open the desktop app to start a meeting.</div>}
    {data?.shortcutErrors?.map(e=><div className="notice" key={e}>{e}</div>)}
    <section className="account-section"><label>Answer backend<select aria-label="Answer backend" value={settings.answerBackend || 'chatgpt'} disabled={!!busy || snapshot.active} onChange={e => { const backend = e.target.value as Settings['answerBackend']; run('Connecting…', async () => { await command('save_settings', { settings: { ...settings, answerBackend: backend, model: backend === 'codex' ? 'gpt-6.1-sol' : '', serviceTier: backend === 'codex' ? 'fast' : null, reasoningEffort: backend === 'codex' && (!settings.reasoningEffort || settings.reasoningEffort === 'xhigh') ? 'low' : settings.reasoningEffort } }); await refresh(); }); }}><option value="codex">Codex</option><option value="chatgpt">ChatGPT plan API</option></select></label><div className="section-label">{codex ? 'YOUR CODEX ACCOUNT' : 'YOUR CHATGPT ACCOUNT'}</div>
      {data?.connectionError && <div className="notice">{data.connectionError}</div>}
      {codex ? <><div className="account-row"><div><strong>{data?.selected?.email || 'Codex account'}</strong><p>{data?.selected ? 'Signed in to Codex' : 'Sign in to connect your Codex models'}</p></div>{data?.selected && <span className="account-dot" />}</div><div className="account-actions"><button disabled={!!busy || snapshot.active} onClick={() => run('Connecting…', refresh)}>Reconnect Codex</button><button className="text-button" disabled={!!busy || snapshot.active} onClick={() => run('Waiting for sign-in…', () => signIn())}>Sign in to Codex ↗</button></div></> : <>
      {data?.selected ? <><div className="account-row"><div><strong>{data.selected.email || data.selected.name || 'ChatGPT account'}</strong><p>{data.selected.planEnabled ? 'ChatGPT plan usage enabled' : 'ChatGPT plan usage is disabled'}</p></div><span className="account-dot" /></div>
        <div className="account-actions"><button disabled={!!busy || snapshot.active} onClick={() => run('Signing in…', () => signIn(data.selected!))}>Continue with ChatGPT</button><button className="text-button" disabled={!!busy} onClick={() => run('Opening…', () => command('manage_usage'))}>Manage usage ↗</button><button className="text-button" disabled={!!busy || snapshot.active} onClick={() => run('Signing out…', async () => { const warning = await command<string | null>('sign_out', { clientId: data.selected!.clientId }); await refresh(); if (warning) setError(warning); })}>Sign out</button></div>
      </> : <button className="chatgpt-button" disabled={!!busy || !native()} onClick={() => run('Waiting for sign-in…', () => signIn())}>Continue with ChatGPT <span>↗</span></button>}
      {data && data.accounts.length > 0 && <label className="account-picker">Saved account<select value={data.selected?.clientId || ''} disabled={!!busy || snapshot.active} onChange={e => run('Switching…', async () => { await command('select_account', { clientId: e.target.value }); await refresh(); })}><option value="" disabled>Choose account</option>{data.accounts.map(a => <option value={a.clientId} key={a.clientId}>{a.email || a.name || 'ChatGPT'} · {a.clientId.slice(-6)}</option>)}</select></label>}
      {data?.selected && <button className="text-button" disabled={!!busy || snapshot.active} onClick={() => run('Waiting for sign-in…', () => signIn())}>Add another account</button>}
      {busy.includes('sign-in') && <button className="text-button" onClick={() => command('cancel_sign_in')}>Cancel sign-in</button>}
      </>}
      {codex && busy.includes('sign-in') && <button className="text-button" onClick={() => command('cancel_sign_in')}>Cancel sign-in</button>}
    </section>
    <section className="device-section"><div className="section-label">READY FOR THE MEETING</div>
      <fieldset disabled={!!busy || snapshot.active}>
        <label>Microphone <span>Your voice · SELF</span><select aria-label="Microphone" value={settings.microphone} onChange={e => setSettings(s => ({ ...s, microphone: e.target.value }))}><option value="">Choose microphone</option>{data?.devices.filter(d => d.source === 'self').map(d => <option key={d.id} value={d.id}>{d.name}{d.default ? ' (default)' : ''}</option>)}</select></label>
        <label>Meeting output <span>Other participants · REMOTE</span><select aria-label="Meeting output" value={settings.output} onChange={e => setSettings(s => ({ ...s, output: e.target.value }))}><option value="">Choose playback device</option>{data?.devices.filter(d => d.source === 'remote').map(d => <option key={d.id} value={d.id}>{d.name}{d.default ? ' (default)' : ''}</option>)}</select></label>
        <p className="field-note">Use the same output device as your meeting. Headphones help keep your microphone separate from other voices.</p>
        <label>Local transcription<select aria-label="Local transcription" value={settings.speechBackend || 'nemotron'} onChange={e => setSettings(s => ({ ...s, speechBackend: e.target.value as Settings['speechBackend'], modelPath: e.target.value === 'nemotron' ? data?.settings.modelPath || '' : '' }))}><option value="nemotron">Nemotron Speech Streaming EN 0.6B</option><option value="whisper">Whisper · legacy local backend</option></select></label>
        <label>Local speech model <input aria-label="Local speech model" value={settings.modelPath} placeholder={nemotron ? 'C:\models\nemotron-speech-streaming-en-0.6b.q8_0.gguf' : 'C:\models\ggml-tiny.en.bin'} onChange={e => setSettings(s => ({ ...s, modelPath: e.target.value }))} /></label>
        {nemotron && <>
          <label>Nemotron runtime<input aria-label="Nemotron runtime" value={settings.nemotronRuntime || ''} placeholder="Path to the installed nemo-speech.exe" onChange={e => setSettings(s => ({ ...s, nemotronRuntime: e.target.value }))} /></label>
          <label>Streaming chunk<select aria-label="Streaming chunk" value={settings.speechChunkMs || 160} onChange={e => setSettings(s => ({ ...s, speechChunkMs: Number(e.target.value) as Settings['speechChunkMs'] }))}>{[80,160,560,1120].map(ms => <option key={ms} value={ms}>{ms} ms{ms === 160 ? ' · default' : ''}</option>)}</select></label>
          <label>Speech GPU<select aria-label="Speech GPU" value={settings.nemotronDeviceName || ''} onChange={e => { const device=data?.speechDevices?.find(d => d.name === e.target.value);setSettings(s => ({ ...s, nemotronDeviceName: device?.name || null, nemotronDevice: device?.index ?? s.nemotronDevice })); }}><option value="">Automatic (prefer a discrete GPU)</option>{data?.speechDevices?.map(d => <option key={d.index} value={d.name}>{d.name}{d.kind === 'integrated-gpu' ? ' (integrated)' : ''}</option>)}</select></label>
          {data?.speechDeviceError && <p className="error" role="alert">{data.speechDeviceError}</p>}
          <p className="field-note">Nemotron keeps a separate streaming cache for each voice source. The GPU is remembered by name when its device index changes. Chunk and GPU changes take effect at the next meeting.</p>
        </>}
        <label>Answer model<select aria-label="Answer model" value={settings.model} onChange={e => setSettings(s => ({ ...s, model: e.target.value }))}><option value="">Sign in to load available models</option>{models.map(m => <option key={m.slug} value={m.slug}>{m.display_name}</option>)}</select></label>
        <label>Reasoning effort<select aria-label="Reasoning effort" value={settings.reasoningEffort || ''} onChange={e => setSettings(s => ({ ...s, reasoningEffort: (e.target.value || null) as Settings['reasoningEffort'] }))}><option value="">Model default</option>{['none', 'low', 'medium', 'high', 'xhigh'].map(e => <option key={e} value={e}>{e}</option>)}</select></label>
        {codex && <label>Answer speed<select aria-label="Answer speed" value={settings.serviceTier || 'default'} onChange={e => setSettings(s => ({ ...s, serviceTier: e.target.value as Settings['serviceTier'] }))}><option value="default">Standard</option><option value="fast">Fast</option></select></label>}
        {codex && <p className="field-note">Fast mode uses more of your Codex allowance. It keeps the selected model and reasoning effort.</p>}
        <p className="field-note">Higher reasoning effort can increase the time to the first answer. Available levels depend on the selected model.</p>
      </fieldset>
    </section>
    <section className="device-section"><div className="section-label">PROJECT CONTEXT</div>
      <label>Project folder<input aria-label="Project folder" value={settings.projectPath || ''} placeholder="Choose the project you want to discuss" disabled={!!busy || snapshot.active} onChange={e => setSettings(s => ({ ...s, projectPath: e.target.value }))} /></label>
      <button disabled={!!busy || snapshot.active || !native()} onClick={() => run('Choosing project…', async () => { const path = await command<string | null>('choose_project'); if (path) setSettings(s => ({ ...s, projectPath: path })); })}>Choose project folder</button>
      <p className="field-note">Ctrl Shift P sends all readable project text to OpenAI and attaches it for follow-up questions. Ignore rules, generated folders and credential files are excluded.</p>
      {snapshot.active && <button disabled={!!busy || snapshot.attachmentBusy || !settings.projectPath} onClick={() => run('Sending project…', () => command('action', { action: 'project' }))}>Send project · Ctrl Shift P</button>}
      <ContextAttachments snapshot={snapshot} onError={setError} />
      {snapshot.active && <button disabled={!!busy || snapshot.attachmentBusy} onClick={() => run('Capturing screen…', () => command('action', { action: 'screenshot' }))}>Send screenshot · Ctrl Shift F8</button>}
      <p className="field-note">The screenshot shortcut sends the monitor under your pointer to OpenAI. It replaces the previous screenshot and remains attached until removed or the meeting stops.</p>
    </section>
    {(error || snapshot.error) && <div role="alert" className="error">{error || snapshot.error}</div>}
    <section className="meeting-control">
      {snapshot.active ? <><Status snapshot={snapshot} /><div className="meters"><Meter label="REMOTE" level={snapshot.remoteLevel} /><Meter label="SELF" level={snapshot.selfLevel} /></div><div className="button-row"><button disabled={!!busy || loading} onClick={() => run('Updating…', () => command('action', { action: 'pause' }))}>{snapshot.paused ? 'Resume listening' : 'Pause listening'}</button><button className="primary" disabled={!!busy && !loading} onClick={() => run('Stopping…', () => command('stop_meeting'))}>{loading ? 'Cancel startup' : 'Stop meeting'}</button></div><form onSubmit={e => { e.preventDefault(); run('Asking…', async () => { await command('ask', { question }); setQuestion(''); }); }}><label className="sr-only" htmlFor="main-question">Ask about this meeting</label><div className="ask-row"><input id="main-question" value={question} maxLength={4000} onChange={e => setQuestion(e.target.value)} placeholder="Ask about this meeting…" /><button disabled={!question.trim() || !!busy || loading}>Ask</button></div></form><button className="text-button" onClick={() => command('action', { action: 'hide' })}>Hide / show overlay</button></> : <button className="primary start" disabled={!canStart || !!busy} onClick={() => run('Starting meeting…', () => command('start_meeting', { settings }))}>{busy || 'Start meeting'} <span>→</span></button>}
      <p className="privacy">Audio and transcription stay on this device. Meeting context is sent to OpenAI to answer questions, with response storage disabled.</p>
    </section>
    <Camera />
    <footer><span>Ask manually <kbd>Ctrl Shift Space</kbd></span><span>Hide overlay <kbd>Ctrl Shift H</kbd></span>{data?.debug && <button className="text-button" onClick={() => command('open_debug')}>Debug transcript</button>}</footer>
  </main>;
}
function Meter({ label, level }: { label: string; level: number }) { return <div className="meter"><span>{label}</span><div><i style={{ width: `${Math.min(100, level * 600)}%` }} /></div></div>; }
