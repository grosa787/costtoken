import type { ModelRate, ProviderId, UsageBucket } from './types';

const CLAUDE_PRICING_SOURCE =
  'https://platform.claude.com/docs/en/about-claude/pricing';
const OPENAI_PRICING_SOURCE = 'https://developers.openai.com/api/docs/pricing';
const GEMINI_PRICING_SOURCE = 'https://ai.google.dev/gemini-api/docs/pricing';
const XAI_PRICING_SOURCE = 'https://docs.x.ai/developers/pricing';

export const BUNDLED_RATES: ModelRate[] = [
  {
    provider: 'gemini',
    model: 'gemini-3.1-pro-preview',
    input: 2,
    output: 12,
    cacheRead: 0.2,
    // The app records no explicit cache creation or storage duration for Gemini CLI.
    cacheWrite: 2,
    source: GEMINI_PRICING_SOURCE,
  },
  {
    provider: 'claude',
    model: 'claude-fable-5',
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
    cacheWrite1h: 20,
    source: CLAUDE_PRICING_SOURCE,
  },
  {
    provider: 'claude',
    model: 'claude-fable-5-1',
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite: 12.5,
    cacheWrite1h: 20,
    source: CLAUDE_PRICING_SOURCE,
  },
  ...['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5'].map(
    (model): ModelRate => ({
      provider: 'claude',
      model,
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
      cacheWrite1h: 10,
      source: CLAUDE_PRICING_SOURCE,
    }),
  ),
  {
    provider: 'claude',
    model: 'claude-opus-5-5',
    input: 4,
    output: 20,
    cacheRead: 0.2,
    cacheWrite: 5,
    cacheWrite1h: 8,
    source: CLAUDE_PRICING_SOURCE,
  },
  {
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite1h: 6,
    source: CLAUDE_PRICING_SOURCE,
  },
  {
    provider: 'claude',
    model: 'claude-sonnet-5',
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    cacheWrite1h: 4,
    source: CLAUDE_PRICING_SOURCE,
  },
  {
    provider: 'claude',
    model: 'claude-haiku-4-5',
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    cacheWrite1h: 2,
    source: CLAUDE_PRICING_SOURCE,
  },
  {
    provider: 'codex',
    model: 'gpt-5.5',
    input: 5,
    output: 30,
    cacheRead: 0.5,
    cacheWrite: 5,
    source: 'https://developers.openai.com/api/docs/models/gpt-5.5',
  },
  {
    provider: 'codex',
    model: 'gpt-5.6-luna',
    input: 0.2,
    output: 1.2,
    cacheRead: 0.02,
    cacheWrite: 0.25,
    source: OPENAI_PRICING_SOURCE,
  },
  {
    provider: 'codex',
    model: 'gpt-5.6-terra',
    input: 2,
    output: 12,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    source: OPENAI_PRICING_SOURCE,
  },
  {
    provider: 'codex',
    model: 'gpt-5.6-sol',
    input: 4,
    output: 20,
    cacheRead: 0.4,
    cacheWrite: 5,
    source: OPENAI_PRICING_SOURCE,
  },
  {
    provider: 'codex',
    model: 'gpt-6-astra',
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
    source: OPENAI_PRICING_SOURCE,
  },
  {
    provider: 'codex',
    model: 'gpt-6-sol',
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    source: OPENAI_PRICING_SOURCE,
  },
  {
    provider: 'codex',
    model: 'gpt-6-luna',
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    source: OPENAI_PRICING_SOURCE,
  },
  ...[
    ['grok-4.6', 2, 0.5, 6],
    ['grok-build-0.1', 1, 0.2, 2],
    ['grok-4.5', 2, 0.3, 6],
    ['grok-4.3', 1.25, 0.2, 2.5],
    ['grok-4.20-multi-agent-0309', 1.25, 0.2, 2.5],
    ['grok-4.20-0309-reasoning', 1.25, 0.2, 2.5],
    ['grok-4.20-0309-non-reasoning', 1.25, 0.2, 2.5],
  ].map(
    ([model, input, cacheRead, output]): ModelRate => ({
      provider: 'grok',
      model: model as string,
      input: input as number,
      output: output as number,
      cacheRead: cacheRead as number,
      // xAI has no separate cache-write rate; cache misses use input pricing.
      cacheWrite: input as number,
      source: XAI_PRICING_SOURCE,
    }),
  ),
];

function normalizeBundledModel(provider: ProviderId, model: string): string {
  let normalized = model.trim().toLowerCase();
  if (provider === 'claude') {
    normalized = normalized.replace(/\s*\[[^\]]+\]\s*$/, '');
    normalized = normalized.replace(/-\d{8}$/, '');
  }
  return normalized;
}

const WRAPPER_VENDOR_PREFIXES: Array<{
  prefix: string;
  provider: ProviderId;
}> = [
  { prefix: 'anthropic/', provider: 'claude' },
  { prefix: 'openai/', provider: 'codex' },
  { prefix: 'xai/', provider: 'grok' },
];

function findWrappedBundledRate(
  wrapperProvider: 'opencode' | 'localcode',
  model: string,
): ModelRate | undefined {
  const trimmedModel = model.trim();
  const lowerModel = trimmedModel.toLowerCase();
  const vendor = WRAPPER_VENDOR_PREFIXES.find(({ prefix }) =>
    lowerModel.startsWith(prefix),
  );

  const matches = vendor
    ? BUNDLED_RATES.filter(
        (rate) =>
          rate.provider === vendor.provider &&
          rate.model ===
            normalizeBundledModel(
              vendor.provider,
              lowerModel.slice(vendor.prefix.length),
            ),
      )
    : BUNDLED_RATES.filter(
        (rate) => rate.model === normalizeBundledModel(rate.provider, lowerModel),
      );

  if (matches.length !== 1) return undefined;
  return { ...matches[0], provider: wrapperProvider, model };
}

export function findRate(
  provider: ProviderId,
  model: string,
  overrides: ModelRate[],
): ModelRate | undefined {
  const override = overrides.find(
    (rate) => rate.provider === provider && rate.model === model,
  );
  if (override) return override;

  if (provider === 'opencode' || provider === 'localcode') {
    return findWrappedBundledRate(provider, model);
  }

  const normalizedModel = normalizeBundledModel(provider, model);
  return BUNDLED_RATES.find(
    (rate) => rate.provider === provider && rate.model === normalizedModel,
  );
}

export function priceBucket(
  bucket: UsageBucket,
  overrides: ModelRate[],
): number | null {
  const rate = findRate(bucket.provider, bucket.model, overrides);
  if (!rate) return null;

  const cacheWrite1hTokens = Math.min(
    Math.max(bucket.cacheWrite1hTokens, 0),
    Math.max(bucket.cacheWriteTokens, 0),
  );
  const ordinaryCacheWriteTokens = Math.max(bucket.cacheWriteTokens, 0) - cacheWrite1hTokens;
  const cacheWrite1hRate = rate.cacheWrite1h ?? rate.cacheWrite;

  return (
    (Math.max(bucket.inputTokens, 0) * rate.input +
      Math.max(bucket.outputTokens, 0) * rate.output +
      Math.max(bucket.cacheReadTokens, 0) * rate.cacheRead +
      ordinaryCacheWriteTokens * rate.cacheWrite +
      cacheWrite1hTokens * cacheWrite1hRate) /
    1_000_000
  );
}
