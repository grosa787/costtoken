import type { ActivityInterval, Period, ProviderId } from './types';
import { periodStart } from './analytics';

export interface ActivitySummary {
  humanSeconds: number;
  agentSeconds: number;
  hasHumanData: boolean;
  hasAgentData: boolean;
}

type Range = [start: number, end: number];

export function summarizeActivity(
  intervals: ActivityInterval[],
  period: Period,
  provider: ProviderId | 'all',
  now: number | Date = Date.now(),
): ActivitySummary {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const upper = nowMs / 1_000;
  const lower = period === 'all' ? Number.NEGATIVE_INFINITY : periodStart(period, nowMs) / 1_000;
  const human: Range[] = [];
  const agent: Range[] = [];
  let hasHumanData = false;
  let hasAgentData = false;

  for (const item of intervals) {
    if (provider !== 'all' && item.provider !== provider) continue;
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end)) continue;
    if (item.end <= item.start || item.start > upper) continue;
    if (item.kind === 'human') hasHumanData = true;
    else if (item.kind === 'agent') hasAgentData = true;
    else continue;

    const start = Math.max(item.start, lower);
    const end = Math.min(item.end, upper);
    if (end <= start) continue;
    (item.kind === 'human' ? human : agent).push([start, end]);
  }

  return {
    humanSeconds: unionSeconds(human),
    agentSeconds: unionSeconds(agent),
    hasHumanData,
    hasAgentData,
  };
}

function unionSeconds(ranges: Range[]): number {
  if (ranges.length === 0) return 0;
  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let total = 0;
  let [start, end] = ranges[0];
  for (const [nextStart, nextEnd] of ranges.slice(1)) {
    if (nextStart <= end) {
      end = Math.max(end, nextEnd);
    } else {
      total += end - start;
      start = nextStart;
      end = nextEnd;
    }
  }
  return total + end - start;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 мин';
  if (seconds < 60) return '<1 мин';
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const hourText = new Intl.NumberFormat('ru-RU').format(hours);
  if (hours === 0) return `${minutes} мин`;
  return minutes === 0 ? `${hourText} ч` : `${hourText} ч ${minutes} мин`;
}
