import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useMeeting } from './state/store';
import type { Snapshot } from './state/model';
export const native = () => isTauri();
export function command<T = void>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!native()) return Promise.reject(new Error('Open Meeting Copilot as a Windows desktop app. Run npm run desktop.'));
  return invoke<T>(name, args);
}
export const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
export async function connectState() {
  if (!native()) return () => {};
  const unlisten = await listen<Snapshot>('copilot:state', ({ payload }) => useMeeting.getState().apply(payload));
  const snapshot = await command<Snapshot>('get_snapshot');
  useMeeting.getState().apply(snapshot);
  return unlisten;
}
