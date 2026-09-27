import { describe, expect, it } from 'vitest';

import type { UsageBucket } from './types';
import { filterBuckets, makeChartPoints, summarize } from './analytics';

const atMs = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
  new Date(year, month - 1, day, hour, minute).getTime();

const at = (year: number, month: number, day: number, hour = 0): number =>
  Math.floor(atMs(year, month, day, hour) / 1_000);

const bucket = (overrides: Partial<UsageBucket> = {}): UsageBucket => ({
  hour: at(2026, 9, 27, 12),
  provider: 'codex',
  model: 'gpt-6-sol',
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 25,
  cacheWriteTokens: 20,
  cacheWrite1hTokens: 5,
  reasoningOutputTokens: 10,
  ...overrides,
});

describe('filterBuckets', () => {
  it('treats UsageBucket.hour as Unix seconds', () => {
    const now = new Date(2026, 8, 27, 15, 37);
    const currentHourSeconds = at(2026, 9, 27, 15);

    expect(
      filterBuckets([bucket({ hour: currentHourSeconds })], 'day', 'all', now),
    ).toHaveLength(1);
  });

  it('uses an inclusive seven-local-day boundary and excludes future buckets', () => {
    const now = atMs(2026, 9, 27, 15);
    const nowSeconds = Math.floor(now / 1_000);
    const start = at(2026, 9, 21);
    const buckets = [
      bucket({ hour: start - 1 }),
      bucket({ hour: start }),
      bucket({ hour: nowSeconds }),
      bucket({ hour: nowSeconds + 1 }),
    ];

    expect(filterBuckets(buckets, 'week', 'all', now).map((item) => item.hour)).toEqual([
      start,
      nowSeconds,
    ]);
  });

  it('applies provider selection independently from an all-time period', () => {
    const buckets = [
      bucket({ provider: 'codex', hour: at(2020, 1, 1) }),
      bucket({ provider: 'claude', hour: at(2020, 1, 1) }),
    ];

    expect(filterBuckets(buckets, 'all', 'claude', atMs(2026, 9, 27))).toEqual([
      buckets[1],
    ]);
  });
});

describe('summarize', () => {
  it('adds independent token categories without double-counting one-hour writes or reasoning', () => {
    const result = summarize(
      [
        bucket({
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 1_000_000,
          cacheWrite1hTokens: 400_000,
          reasoningOutputTokens: 700_000,
        }),
      ],
      [],
    );

    expect(result).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      reasoningOutputTokens: 700_000,
      totalTokens: 4_000_000,
      estimatedCost: 14.7,
      unpricedModels: [],
    });
  });

  it('keeps a partial estimate and lists each unknown model once', () => {
    const result = summarize(
      [
        bucket({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 }),
        bucket({ model: 'unknown-z', inputTokens: 10 }),
        bucket({ model: 'unknown-z', inputTokens: 20 }),
        bucket({ provider: 'claude', model: 'unknown-z', inputTokens: 20 }),
        bucket({ model: 'unknown-a', inputTokens: 30 }),
      ],
      [],
    );

    expect(result.estimatedCost).toBe(2);
    expect(result.unpricedModels).toEqual([
      'claude:unknown-z',
      'codex:unknown-a',
      'codex:unknown-z',
    ]);
  });
});

describe('makeChartPoints', () => {
  it('groups day data by local hour and flags groups containing unpriced usage', () => {
    const points = makeChartPoints(
      [
        bucket({ hour: at(2026, 9, 27, 10), inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 }),
        bucket({ hour: at(2026, 9, 27, 10) + 30 * 60, inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 }),
        bucket({ hour: at(2026, 9, 27, 11), model: 'unknown', inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 }),
      ],
      'day',
      [],
    );

    expect(points).toEqual([
      {
        key: '2026-09-27T10',
        label: '10:00',
        estimatedCost: 12,
        totalTokens: 2_000_000,
        unpriced: false,
      },
      {
        key: '2026-09-27T11',
        label: '11:00',
        estimatedCost: 0,
        totalTokens: 5,
        unpriced: true,
      },
    ]);
  });

  it('inserts zero points for inactive intervals between occupied groups', () => {
    const points = makeChartPoints(
      [
        bucket({ hour: at(2026, 9, 27, 10) }),
        bucket({ hour: at(2026, 9, 27, 12) }),
      ],
      'day',
      [],
    );

    expect(points.map((point) => [point.key, point.totalTokens, point.estimatedCost])).toEqual([
      ['2026-09-27T10', 195, 0.000755],
      ['2026-09-27T11', 0, 0],
      ['2026-09-27T12', 195, 0.000755],
    ]);
    expect(points[1].unpriced).toBe(false);
  });

  it('uses day, week, and month keys for the requested longer periods', () => {
    const sample = [bucket({ hour: at(2026, 9, 27, 12) })];

    expect(makeChartPoints(sample, 'month', [])[0].key).toBe('2026-09-27');
    expect(makeChartPoints(sample, 'sixMonths', [])[0].key).toBe('2026-09-21');
    expect(makeChartPoints(sample, 'all', [])[0].key).toBe('2026-09');
  });
});
