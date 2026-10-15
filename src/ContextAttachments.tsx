import { command, errorText } from './bridge';
import type { Snapshot } from './state/model';
export default function ContextAttachments({ snapshot, onError }: { snapshot: Snapshot; onError: (error: string) => void }) {
  const clear = () => command('action', { action: 'clear_project' }).catch(e => onError(errorText(e)));
  if (!snapshot.project && !snapshot.screenshot && !snapshot.attachmentBusy) return null;
  return <div className="context-attachments" aria-live="polite">
    {snapshot.attachmentBusy && <p>Preparing context…</p>}
    {snapshot.screenshot && <p>Screenshot attached · {snapshot.screenshot.width} × {snapshot.screenshot.height} <button onClick={() => command('action', { action: 'clear_screenshot' }).catch(e => onError(errorText(e)))}>Remove screenshot</button></p>}
    {snapshot.project && <><p><strong title={snapshot.project.sourcePath}>{snapshot.project.name}</strong> · {snapshot.project.files} files attached <button disabled={!snapshot.active || snapshot.attachmentBusy} title="Read saved changes from the same project folder" onClick={() => command('action', { action: 'refresh_project' }).catch(e => onError(errorText(e)))}>Refresh project</button><button onClick={clear}>Remove project</button></p>
      {snapshot.project.collectedAt && <p>Saved files read at <time dateTime={new Date(snapshot.project.collectedAt).toISOString()} title={new Date(snapshot.project.collectedAt).toLocaleString()}>{new Date(snapshot.project.collectedAt).toLocaleTimeString()}</time>. Refresh after saving edits.</p>}
      {snapshot.project.filePaths && <details><summary>Included files · {new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(snapshot.project.bytes / 1024)} KiB</summary><ul>{snapshot.project.filePaths.map(path => <li key={path}>{path}</li>)}</ul></details>}
      {snapshot.project.skipped.length > 0 && <details><summary>{snapshot.project.skipped.length} files skipped</summary><ul>{snapshot.project.skipped.map(file => <li key={file.path}>{file.path} — {file.reason}</li>)}</ul></details>}</>}
  </div>;
}
