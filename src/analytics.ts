import type { ModelRate, Period, ProviderId, UsageBucket } from './types';
import { priceBucket } from './pricing';

export interface Summary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  unpricedModels: string[];
}

export interface ChartPoint {
  key: string;
  label: string;
  estimatedCost: number;
  totalTokens: number;
  unpriced: boolean;
}

export function filterBuckets(
  buckets: UsageBucket[],
  period: Period,
  provider: ProviderId | 'all',
  now: number | Date = Date.now(),
): UsageBucket[] {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const providerBuckets =
    provider === 'all' ? buckets : buckets.filter((bucket) => bucket.provider === provider);
  if (period === 'all') return providerBuckets;

  const start = periodStart(period, nowMs);
  return providerBuckets.filter((bucket) => {
    const bucketMs = unixSecondsToMs(bucket.hour);
    return bucketMs >= start && bucketMs <= nowMs;
  });
}

export function summarize(buckets: UsageBucket[], overrides: ModelRate[]): Summary {
  const summary: Summary = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedCost: 0,
    unpricedModels: [],
  };
  const unpricedModels = new Set<string>();

  for (const bucket of buckets) {
    const inputTokens = nonNegative(bucket.inputTokens);
    const outputTokens = nonNegative(bucket.outputTokens);
    const cacheReadTokens = nonNegative(bucket.cacheReadTokens);
    const cacheWriteTokens = nonNegative(bucket.cacheWriteTokens);

    summary.inputTokens += inputTokens;
    summary.outputTokens += outputTokens;
    summary.cacheReadTokens += cacheReadTokens;
    summary.cacheWriteTokens += cacheWriteTokens;
    summary.reasoningOutputTokens += nonNegative(bucket.reasoningOutputTokens);
    summary.totalTokens += inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

    const cost = priceBucket(bucket, overrides);
    if (cost === null) {
      unpricedModels.add(`${bucket.provider}:${bucket.model}`);
    } else {
      summary.estimatedCost += cost;
    }
  }

  summary.unpricedModels = [...unpricedModels].sort((left, right) =>
    left.localeCompare(right),
  );
  return summary;
}

export function makeChartPoints(
  buckets: UsageBucket[],
  period: Period,
  overrides: ModelRate[],
): ChartPoint[] {
  const groups = new Map<
    string,
    { label: string; startMs: number; buckets: UsageBucket[] }
  >();

  for (const bucket of buckets) {
    const group = chartGroupFromMs(unixSecondsToMs(bucket.hour), period);
    const current = groups.get(group.key);
    if (current) {
      current.buckets.push(bucket);
    } else {
      groups.set(group.key, {
        label: group.label,
        startMs: group.startMs,
        buckets: [bucket],
      });
    }
  }

  if (groups.size === 0) return [];

  const occupiedGroups = [...groups.values()].sort((left, right) => left.startMs - right.startMs);
  const lastStartMs = occupiedGroups.at(-1)!.startMs;
  const points: ChartPoint[] = [];

  for (
    let cursorMs = occupiedGroups[0].startMs;
    cursorMs <= lastStartMs;
    cursorMs = nextChartGroupStart(cursorMs, period)
  ) {
    const identity = chartGroupFromMs(cursorMs, period);
    const group = groups.get(identity.key);
    if (!group) {
      points.push({
        key: identity.key,
        label: identity.label,
        estimatedCost: 0,
        totalTokens: 0,
        unpriced: false,
      });
      continue;
    }

    const summary = summarize(group.buckets, overrides);
    points.push({
      key: identity.key,
      label: group.label,
      estimatedCost: summary.estimatedCost,
      totalTokens: summary.totalTokens,
      unpriced: summary.unpricedModels.length > 0,
    });
  }

  return points;
}

function nonNegative(value: number): number {
  return Math.max(value, 0);
}

function unixSecondsToMs(seconds: number): number {
  return seconds * 1_000;
}

function startOfLocalDay(timestamp: number): Date {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date;
}

function subtractCalendarMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() - months);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, lastDay));
  return result;
}

export function periodStart(period: Exclude<Period, 'all'>, now: number): number {
  const start = startOfLocalDay(now);
  switch (period) {
    case 'day':
      return start.getTime();
    case 'week':
      start.setDate(start.getDate() - 6);
      return start.getTime();
    case 'month':
      start.setDate(start.getDate() - 29);
      return start.getTime();
    case 'sixMonths':
      return subtractCalendarMonths(start, 6).getTime();
    case 'year':
      return subtractCalendarMonths(start, 12).getTime();
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localMonthKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function startOfLocalWeek(timestamp: number): Date {
  const date = startOfLocalDay(timestamp);
  const daysSinceMonday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - daysSinceMonday);
  return date;
}

function chartGroupFromMs(
  timestampMs: number,
  period: Period,
): { key: string; label: string; startMs: number } {
  const date = new Date(timestampMs);

  if (period === 'day') {
    date.setMinutes(0, 0, 0);
    const hour = pad(date.getHours());
    return {
      key: `${localDayKey(date)}T${hour}`,
      label: `${hour}:00`,
      startMs: date.getTime(),
    };
  }

  if (period === 'week' || period === 'month') {
    date.setHours(0, 0, 0, 0);
    return {
      key: localDayKey(date),
      label: date.toLocaleDateString('ru-RU', { month: 'short', day: 'numeric' }),
      startMs: date.getTime(),
    };
  }

  if (period === 'sixMonths' || period === 'year') {
    const week = startOfLocalWeek(timestampMs);
    return {
      key: localDayKey(week),
      label: week.toLocaleDateString('ru-RU', { month: 'short', day: 'numeric' }),
      startMs: week.getTime(),
    };
  }

  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return {
    key: localMonthKey(date),
    label: date.toLocaleDateString('ru-RU', { month: 'short', year: 'numeric' }),
    startMs: date.getTime(),
  };
}

function nextChartGroupStart(timestampMs: number, period: Period): number {
  const next = new Date(timestampMs);
  if (period === 'day') {
    next.setHours(next.getHours() + 1);
  } else if (period === 'week' || period === 'month') {
    next.setDate(next.getDate() + 1);
  } else if (period === 'sixMonths' || period === 'year') {
    next.setDate(next.getDate() + 7);
  } else {
    next.setMonth(next.getMonth() + 1);
  }
  return next.getTime();
}
