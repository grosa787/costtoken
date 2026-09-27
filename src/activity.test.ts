import { describe, expect, it } from 'vitest';
import { formatDuration, summarizeActivity } from './activity';
import type { ActivityInterval } from './types';

const interval = (
  provider: ActivityInterval['provider'],
  kind: ActivityInterval['kind'],
  start: number,
  end: number,
): ActivityInterval => ({ provider, kind, start, end });

describe('summarizeActivity', () => {
  it('unions parallel activity without counting overlapping minutes twice', () => {
    const records = [
      interval('claude', 'human', 100, 400),
      interval('codex', 'human', 200, 500),
      interval('claude', 'agent', 120, 300),
      interval('codex', 'agent', 250, 450),
    ];
    const now = new Date(2026, 8, 27);

    expect(summarizeActivity(records, 'all', 'all', now)).toMatchObject({
      humanSeconds: 400,
      agentSeconds: 330,
      hasHumanData: true,
      hasAgentData: true,
    });
    expect(summarizeActivity(records, 'all', 'claude', now)).toMatchObject({
      humanSeconds: 300,
      agentSeconds: 180,
    });
  });

  it('clips intervals to the current local day and the current time', () => {
    const start = Math.floor(new Date(2026, 8, 27, 0, 0, 0).getTime() / 1_000);
    const now = new Date(2026, 8, 27, 12, 0, 0);
    const records = [
      interval('claude', 'human', start - 120, start + 180),
      interval('claude', 'agent', Math.floor(now.getTime() / 1_000) - 30, Math.floor(now.getTime() / 1_000) + 500),
    ];

    expect(summarizeActivity(records, 'day', 'claude', now)).toMatchObject({
      humanSeconds: 180,
      agentSeconds: 30,
    });
  });

  it('shows zero for an inactive day but unavailable for a provider without timings', () => {
    const yesterday = Math.floor(new Date(2026, 8, 26, 10, 0, 0).getTime() / 1_000);
    const now = new Date(2026, 8, 27, 12, 0, 0);
    const records = [interval('claude', 'human', yesterday, yesterday + 180)];

    expect(summarizeActivity(records, 'day', 'claude', now)).toMatchObject({
      humanSeconds: 0,
      hasHumanData: true,
      agentSeconds: 0,
      hasAgentData: false,
    });
    expect(summarizeActivity(records, 'day', 'gemini', now).hasHumanData).toBe(false);
  });

  it('ignores malformed or zero-length intervals', () => {
    const records = [
      interval('claude', 'human', 100, 100),
      interval('claude', 'human', 300, 200),
      interval('claude', 'agent', Number.NaN, 300),
    ];
    expect(summarizeActivity(records, 'all', 'all', new Date(2026, 8, 27))).toMatchObject({
      humanSeconds: 0,
      agentSeconds: 0,
      hasHumanData: false,
      hasAgentData: false,
    });
  });
});

describe('formatDuration', () => {
  it('formats accumulated hours like playtime', () => {
    expect(formatDuration(0)).toBe('0 мин');
    expect(formatDuration(30)).toBe('<1 мин');
    expect(formatDuration(3_661)).toBe('1 ч 1 мин');
    expect(formatDuration(72_000)).toBe('20 ч');
  });
});
