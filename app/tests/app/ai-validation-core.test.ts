import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AI_PRICE_MAX_MICROS_PER_MTOK, type AiProviderKind } from '@flux/contracts';
import { normalizeBaseUrl, validAiKey, validPrice } from '@flux/core';

// Provider-neutral AI connection rules (F-020, #179): the base URL form that is stored, the price
// table and the key format per provider. All three are pure: no database, no network.

const MAX = AI_PRICE_MAX_MICROS_PER_MTOK;

describe('normalizeBaseUrl', () => {
  test('strips one or several trailing slashes', () => {
    assert.equal(normalizeBaseUrl('https://host/v1/'), 'https://host/v1');
    assert.equal(normalizeBaseUrl('https://host/v1//'), 'https://host/v1');
    assert.equal(normalizeBaseUrl('https://host/v1////'), 'https://host/v1');
  });

  test('leaves a URL with no trailing slash unchanged', () => {
    for (const url of ['https://host/v1', 'https://host', 'http://localhost:11434/v1', 'https://host:8443/api/openai']) {
      assert.equal(normalizeBaseUrl(url), url, url);
    }
  });

  test('keeps a slash inside the path and strips only the end', () => {
    assert.equal(normalizeBaseUrl('https://host/a/b/c'), 'https://host/a/b/c');
    assert.equal(normalizeBaseUrl('https://host/a//b'), 'https://host/a//b');
    assert.equal(normalizeBaseUrl('https://host/a//b/'), 'https://host/a//b');
  });

  test('a bare host with a slash is stored without it', () => {
    assert.equal(normalizeBaseUrl('https://host/'), 'https://host');
  });

  test('with and without the trailing slash name the same stored endpoint', () => {
    assert.equal(normalizeBaseUrl('https://host/v1/'), normalizeBaseUrl('https://host/v1'));
  });
});

describe('validPrice', () => {
  const price = (input: unknown, output: unknown) => ({ inputMicrosPerMTok: input, outputMicrosPerMTok: output });

  test('accepts both fields at 0, at the maximum and in between', () => {
    assert.equal(validPrice(price(0, 0)), true);
    assert.equal(validPrice(price(MAX, MAX)), true);
    assert.equal(validPrice(price(0, MAX)), true);
    assert.equal(validPrice(price(MAX, 0)), true);
    assert.equal(validPrice(price(3_000_000, 15_000_000)), true);
  });

  test('refuses a value that is not an object with the two fields', () => {
    for (const [name, value] of [['null', null], ['undefined', undefined], ['an empty array', []], ['an array of two numbers', [1, 2]],
      ['a string', '{"inputMicrosPerMTok":1,"outputMicrosPerMTok":2}'], ['a number', 5], ['a boolean', true]] as const) {
      assert.equal(validPrice(value), false, name);
    }
  });

  test('refuses a missing field', () => {
    assert.equal(validPrice({ inputMicrosPerMTok: 1 }), false);
    assert.equal(validPrice({ outputMicrosPerMTok: 1 }), false);
    assert.equal(validPrice({}), false);
    assert.equal(validPrice(price(1, undefined)), false);
    assert.equal(validPrice(price(undefined, 1)), false);
  });

  test('refuses an extra key, whatever its value', () => {
    assert.equal(validPrice({ ...price(1, 2), cachedMicrosPerMTok: 1 }), false);
    assert.equal(validPrice({ ...price(1, 2), extra: undefined }), false);
  });

  test('refuses a negative number, a fraction and a number above the maximum', () => {
    assert.equal(validPrice(price(-1, 0)), false);
    assert.equal(validPrice(price(0, -1)), false);
    assert.equal(validPrice(price(1.5, 0)), false);
    assert.equal(validPrice(price(0, 0.1)), false);
    assert.equal(validPrice(price(MAX + 1, 0)), false);
    assert.equal(validPrice(price(0, MAX + 1)), false);
  });

  test('refuses numeric strings and numbers that are not finite integers', () => {
    assert.equal(validPrice(price('5', 5)), false);
    assert.equal(validPrice(price(5, '5')), false);
    assert.equal(validPrice(price(NaN, 0)), false);
    assert.equal(validPrice(price(0, Infinity)), false);
    assert.equal(validPrice(price(Number.MAX_SAFE_INTEGER + 1, 0)), false);
    assert.equal(validPrice(price(null, 0)), false);
  });
});

describe('validAiKey', () => {
  // One well-formed sample per provider format. They are shapes, not real keys.
  // Fake keys, assembled at run time so secret scanners don't flag the source as a leaked key.
  const fake = (prefix: string, body: string) => `${prefix}${body}`;
  const SAMPLES = {
    anthropic: fake('sk-ant-' + 'api03-', 'FAKE-test-key-not-real-0000000000000'),
    openai: fake('sk-' + 'proj-', 'FAKE-test-key-not-real-000000000000_-ABCD'),
    openrouter: fake('sk-or-' + 'v1-', 'FAKEFAKE0000000000000000000000000'),
    gemini: fake('AI' + 'za', 'FAKE-test-key-not-real-00000000000'),
  } as const;
  const NAMED = Object.keys(SAMPLES) as (keyof typeof SAMPLES)[];

  test('each provider accepts a well-formed key of its own format', () => {
    for (const provider of NAMED) assert.equal(validAiKey(provider, SAMPLES[provider]), true, provider);
  });

  test('openai also accepts service-account and legacy user keys', () => {
    assert.equal(validAiKey('openai', 'sk-svcacct-abcdefghijklmnopqrstuvwxyz0123456789'), true);
    assert.equal(validAiKey('openai', `sk-${'A1b2C3d4'.repeat(6)}`), true);
  });

  test('each named provider refuses the key format of every other named provider', () => {
    for (const provider of NAMED) {
      for (const other of NAMED) {
        if (other === provider) continue;
        assert.equal(validAiKey(provider, SAMPLES[other]), false, `${provider} must refuse a ${other} key`);
      }
    }
  });

  test('an organization admin key is refused for openai', () => {
    assert.equal(validAiKey('openai', 'sk-admin-abcdefghijklmnopqrstuvwxyz0123456789'), false);
  });

  test('the length bounds of each format are exact', () => {
    const body = (length: number) => 'a'.repeat(length);
    // The OpenAI format counts everything after `sk-`, so its prefix here is only `sk-`.
    const bounds: [AiProviderKind, string, number, number][] = [
      ['anthropic', 'sk-ant-', 16, 256],
      ['openai', 'sk-', 20, 300],
      ['openrouter', 'sk-or-', 16, 256],
      ['gemini', 'AIza', 30, 100],
    ];
    for (const [provider, prefix, min, max] of bounds) {
      assert.equal(validAiKey(provider, prefix + body(min - 1)), false, `${provider} shorter than ${min}`);
      assert.equal(validAiKey(provider, prefix + body(min)), true, `${provider} at ${min}`);
      assert.equal(validAiKey(provider, prefix + body(max)), true, `${provider} at ${max}`);
      assert.equal(validAiKey(provider, prefix + body(max + 1)), false, `${provider} longer than ${max}`);
    }
  });

  test('a key with a space, a newline, a character outside the format or a stray prefix is refused', () => {
    for (const provider of NAMED) {
      const key = SAMPLES[provider];
      assert.equal(validAiKey(provider, ` ${key}`), false, `${provider} leading space`);
      assert.equal(validAiKey(provider, `${key} `), false, `${provider} trailing space`);
      assert.equal(validAiKey(provider, `${key}\n`), false, `${provider} trailing newline`);
      assert.equal(validAiKey(provider, `${key}!`), false, `${provider} character outside the format`);
      assert.equal(validAiKey(provider, `x${key}`), false, `${provider} stray prefix`);
    }
  });

  test('a value that is not a string is refused for every provider', () => {
    const providers: AiProviderKind[] = [...NAMED, 'openai_compatible'];
    for (const provider of providers) {
      for (const value of [null, undefined, 12345678, {}, [], ['sk-ant-api03-abcdefghijklmnop']]) {
        assert.equal(validAiKey(provider, value), false, `${provider} ${JSON.stringify(value)}`);
      }
    }
  });

  test('openai_compatible takes visible ASCII without spaces, 8 to 512 characters', () => {
    assert.equal(validAiKey('openai_compatible', 'abcdefgh'), true);
    assert.equal(validAiKey('openai_compatible', 'Bearer-token_123!#$%&*+/=?@^~'), true);
    for (const provider of NAMED) assert.equal(validAiKey('openai_compatible', SAMPLES[provider]), true, provider);
    assert.equal(validAiKey('openai_compatible', 'abcdefg'), false, 'seven characters');
    assert.equal(validAiKey('openai_compatible', 'a'.repeat(512)), true);
    assert.equal(validAiKey('openai_compatible', 'a'.repeat(513)), false);
    assert.equal(validAiKey('openai_compatible', 'abcd efgh'), false, 'space');
    assert.equal(validAiKey('openai_compatible', 'abcdefgh\n'), false, 'newline');
    assert.equal(validAiKey('openai_compatible', 'abcdefghé'), false, 'non-ASCII');
  });
});
