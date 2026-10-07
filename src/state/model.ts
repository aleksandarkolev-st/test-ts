export type SpeakerSource = 'self' | 'remote';
export interface TranscriptSegment { id: string; source: SpeakerSource; text: string; startedAt: number; endedAt: number; final: boolean }
export interface CurrentQuestion { id: string; text: string; detectedAt: number }
export interface Latency { speechStoppedAt: number; transcriptFinalAt: number; questionConfirmedAt: number; requestSentAt: number; firstTokenAt: number | null; completedAt: number | null }
export interface Snapshot {
  questions?: { id: string; text: string; state: 'speculative' | 'confirmed' | 'superseded' | 'cancelled' | 'complete'; queued: boolean }[];
  revision: number; active: boolean; paused: boolean;
  status: 'off' | 'loading' | 'listening' | 'question' | 'thinking' | 'answer' | 'error';
  question: CurrentQuestion | null; answer: string; error: string | null;
  protection: boolean; expanded: boolean; manual: boolean; latency: Latency | null;
  remoteLevel: number; selfLevel: number;
  project: { name: string; files: number; bytes: number; skipped: { path: string; reason: string }[] } | null;
  attachmentBusy: boolean;
  screenshot: { width: number; height: number } | null;
}
export interface Settings { microphone: string; output: string; modelPath: string; model: string; speechBackend?: 'nemotron' | 'whisper'; speechChunkMs?: 80 | 160 | 560 | 1120; nemotronRuntime?: string; nemotronDevice?: number; projectPath?: string; reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | null; answerBackend?: 'chatgpt' | 'codex'; serviceTier?: 'default' | 'fast' | null }
export interface AudioDevice { id: string; name: string; source: SpeakerSource; default: boolean }
export interface Account { clientId: string; email: string | null; name: string | null; planEnabled: boolean }
export interface Model { slug: string; display_name: string }
export interface Bootstrap { settings: Settings; devices: AudioDevice[]; accounts: Account[]; selected: Account | null; models: Model[]; snapshot: Snapshot; debug: boolean; shortcutErrors: string[]; connectionError?: string | null }
export const initialSnapshot: Snapshot = { revision: 0, active: false, paused: false, status: 'off', question: null, answer: '', error: null, protection: false, expanded: false, manual: false, latency: null, remoteLevel: 0, selfLevel: 0, project: null, attachmentBusy: false, screenshot: null };
