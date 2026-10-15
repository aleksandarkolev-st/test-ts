import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useMeeting } from './state/store';
import type { Snapshot } from './state/model';
export const native = () => isTauri();
let runtimeReady: Promise<void> | undefined;
async function waitForRuntime() {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await invoke<boolean>('runtime_ready')) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Application startup timed out. Reopen the app and try again.');
}
async function ready() {
  runtimeReady ??= waitForRuntime().catch(error => { runtimeReady = undefined; throw error; });
  await runtimeReady;
}
export async function command<T = void>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!native()) throw new Error('Open Meeting Copilot as a Windows desktop app. Run npm run desktop.');
  await ready();
  return invoke<T>(name, args);
}
export const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
export async function connectState() {
  if (!native()) return () => {};
  await ready();
  const unlisten = await listen<Snapshot>('copilot:state', ({ payload }) => useMeeting.getState().apply(payload));
  const snapshot = await command<Snapshot>('get_snapshot');
  useMeeting.getState().apply(snapshot);
  return unlisten;
}
