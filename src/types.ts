export type ProviderId = 'claude' | 'codex' | 'gemini' | 'antigravity' | 'grok' | 'opencode' | 'localcode' | 'cursor';

export interface UsageBucket {
  hour: number;
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  reasoningOutputTokens: number;
}

export interface SourceStatus {
  id: ProviderId;
  name: string;
  status: 'ready' | 'absent' | 'unsupported' | 'error';
  fileCount: number;
  eventCount: number;
  detail: string;
}

export interface ScanReport {
  buckets: UsageBucket[];
  sources: SourceStatus[];
  scannedAt: number;
}

export type Period = 'day' | 'week' | 'month' | 'sixMonths' | 'year' | 'all';

export interface ModelRate {
  model: string;
  provider: ProviderId;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  source?: string;
}
