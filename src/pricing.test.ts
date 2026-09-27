import { describe, expect, it } from 'vitest';

import type { ModelRate, UsageBucket } from './types';
import { findRate, priceBucket } from './pricing';

const bucket = (overrides: Partial<UsageBucket> = {}): UsageBucket => ({
  hour: Math.floor(new Date(2026, 8, 27, 12).getTime() / 1_000),
  provider: 'claude',
  model: 'claude-sonnet-5',
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 1_000_000,
  cacheWrite1hTokens: 250_000,
  reasoningOutputTokens: 400_000,
  ...overrides,
});

describe('findRate', () => {
  it('uses the published short-context token rates for Gemini 3.1 Pro', () => {
    expect(findRate('gemini', 'gemini-3.1-pro-preview', [])).toMatchObject({
      input: 2,
      output: 12,
      cacheRead: 0.2,
    });
  });

  it('uses GPT-5.5 cached reads without inventing a cache-write surcharge', () => {
    expect(findRate('codex', 'gpt-5.5', [])).toMatchObject({
      input: 5,
      output: 30,
      cacheRead: 0.5,
      cacheWrite: 5,
    });
  });
  it('matches a Claude date suffix and context bracket suffix without guessing other names', () => {
    const rate = findRate(
      'claude',
      'claude-sonnet-4-6-20250514 [1m]',
      [],
    );

    expect(rate?.model).toBe('claude-sonnet-4-6');
    expect(rate?.input).toBe(3);
    expect(rate?.cacheRead).toBe(0.3);
    expect(findRate('claude', 'sonnet-4-6', [])).toBeUndefined();
  });

  it('prefers an exact provider and model override over a bundled rate', () => {
    const custom: ModelRate = {
      provider: 'codex',
      model: 'gpt-6-sol',
      input: 9,
      output: 8,
      cacheRead: 7,
      cacheWrite: 6,
    };

    expect(findRate('codex', 'gpt-6-sol', [custom])).toEqual(custom);
    expect(findRate('codex', 'GPT-6-SOL', [custom])?.input).toBe(2);
  });

  it('resolves exact underlying wrapper models and preserves their display identity', () => {
    const claudeModel = 'anthropic/claude-sonnet-4-6-20250514 [1m]';
    const claudeRate = findRate('opencode', claudeModel, []);
    const openAiRate = findRate('localcode', 'openai/gpt-6-sol', []);
    const xaiRate = findRate('localcode', 'grok-4.6', []);

    expect(claudeRate).toMatchObject({
      provider: 'opencode',
      model: claudeModel,
      input: 3,
      output: 15,
    });
    expect(openAiRate).toMatchObject({
      provider: 'localcode',
      model: 'openai/gpt-6-sol',
      input: 2,
      output: 10,
    });
    expect(xaiRate).toMatchObject({
      provider: 'localcode',
      model: 'grok-4.6',
      input: 2,
      cacheRead: 0.5,
    });
  });

  it('does not fuzzy-match wrapper names or unwrap models for other providers', () => {
    expect(findRate('opencode', 'sonnet-4-6', [])).toBeUndefined();
    expect(findRate('localcode', 'openai/gpt-6-sol-latest', [])).toBeUndefined();
    expect(findRate('opencode', 'anthropic/openai/gpt-6-sol', [])).toBeUndefined();
    expect(findRate('cursor', 'openai/gpt-6-sol', [])).toBeUndefined();
  });
});

describe('priceBucket', () => {
  it('prices the one-hour write subset at its own rate and does not double-count reasoning', () => {
    // Sonnet 5 per-million rates: input 2, output 10, read .2,
    // 5m write 2.5, 1h write 4. The 1h writes are a 250k subset.
    expect(priceBucket(bucket(), [])).toBeCloseTo(15.075, 10);
  });

  it('uses the ordinary write rate for all writes when no one-hour rate exists', () => {
    const custom: ModelRate = {
      provider: 'opencode',
      model: 'local-priced',
      input: 1,
      output: 2,
      cacheRead: 0.5,
      cacheWrite: 3,
    };

    expect(
      priceBucket(
        bucket({
          provider: 'opencode',
          model: 'local-priced',
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 1_000_000,
          cacheWrite1hTokens: 400_000,
          reasoningOutputTokens: 0,
        }),
        [custom],
      ),
    ).toBe(3);
  });

  it('returns null when a model has no bundled or overridden rate', () => {
    expect(priceBucket(bucket({ model: 'claude-unknown-99' }), [])).toBeNull();
  });
});
