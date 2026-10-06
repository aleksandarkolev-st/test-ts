import { command, errorText } from './bridge';
import type { Snapshot } from './state/model';
export default function ContextAttachments({ snapshot, onError }: { snapshot: Snapshot; onError: (error: string) => void }) {
  const clear = () => command('action', { action: 'clear_project' }).catch(e => onError(errorText(e)));
  if (!snapshot.project && !snapshot.attachmentBusy) return null;
  return <div className="context-attachments" aria-live="polite">
    {snapshot.attachmentBusy && <p>Reading project files…</p>}
    {snapshot.project && <><p><strong>{snapshot.project.name}</strong> · {snapshot.project.files} files attached <button onClick={clear}>Remove project</button></p>
      {snapshot.project.skipped.length > 0 && <details><summary>{snapshot.project.skipped.length} files skipped</summary><ul>{snapshot.project.skipped.map(file => <li key={file.path}>{file.path} — {file.reason}</li>)}</ul></details>}</>}
  </div>;
}
