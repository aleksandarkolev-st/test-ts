import { command, errorText } from './bridge';
import type { Snapshot } from './state/model';
export default function ContextAttachments({ snapshot, onError }: { snapshot: Snapshot; onError: (error: string) => void }) {
  const clear = () => command('action', { action: 'clear_project' }).catch(e => onError(errorText(e)));
  if (!snapshot.project && !snapshot.screenshot && !snapshot.attachmentBusy && !snapshot.task.testOutput) return null;
  return <div className="context-attachments" aria-live="polite">
    {snapshot.attachmentBusy && <p>Preparing context…</p>}
    {snapshot.screenshot && <p>Screenshot attached · {snapshot.screenshot.width} × {snapshot.screenshot.height} <button onClick={() => command('action', { action: 'clear_screenshot' }).catch(e => onError(errorText(e)))}>Remove screenshot</button></p>}
    {snapshot.screenshot?.capturedAt ? <p>Screenshot captured at <time dateTime={new Date(snapshot.screenshot.capturedAt).toISOString()} title={new Date(snapshot.screenshot.capturedAt).toLocaleString()}>{new Date(snapshot.screenshot.capturedAt).toLocaleTimeString()}</time>. Retake after the screen changes.</p> : null}
    {snapshot.project && <><p><strong title={snapshot.project.sourcePath}>{snapshot.project.name}</strong> · {snapshot.project.files} files attached <button disabled={!snapshot.active || snapshot.attachmentBusy} title="Read saved changes from the same project folder" onClick={() => command('action', { action: 'refresh_project' }).catch(e => onError(errorText(e)))}>Refresh project</button><button onClick={clear}>Remove project</button></p>
      {snapshot.project.collectedAt ? <p>{snapshot.project.files} saved files updated at <time dateTime={new Date(snapshot.project.collectedAt).toISOString()} title={new Date(snapshot.project.collectedAt).toLocaleString()}>{new Date(snapshot.project.collectedAt).toLocaleTimeString()}</time>. Refresh after saving edits.</p> : null}
      {snapshot.project.filePaths && <details><summary>Included files · {new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(snapshot.project.bytes / 1024)} KiB</summary><ul>{snapshot.project.filePaths.map(path => <li key={path}>{path}</li>)}</ul></details>}
      {snapshot.project.skipped.length > 0 && <details><summary>{snapshot.project.skipped.length} files skipped</summary><ul>{snapshot.project.skipped.map(file => <li key={file.path}>{file.path} — {file.reason}</li>)}</ul></details>}</>}
    {snapshot.task.testOutput && <p>Test output updated at <time dateTime={new Date(snapshot.task.testOutput.updatedAt).toISOString()} title={new Date(snapshot.task.testOutput.updatedAt).toLocaleString()}>{new Date(snapshot.task.testOutput.updatedAt).toLocaleTimeString()}</time>.</p>}
  </div>;
}
