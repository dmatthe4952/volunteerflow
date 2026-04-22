import { describe, expect, test } from 'vitest';
import { retryAsync } from '../src/retry.js';

describe('retryAsync', () => {
  test('retries failures and eventually succeeds', async () => {
    let attempts = 0;
    const res = await retryAsync(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('temporary');
        return 'ok';
      },
      { attempts: 3, baseDelayMs: 1, backoffFactor: 1 }
    );
    expect(res).toBe('ok');
    expect(attempts).toBe(3);
  });

  test('throws after exhausting attempts', async () => {
    let attempts = 0;
    await expect(
      retryAsync(
        async () => {
          attempts += 1;
          throw new Error('always fails');
        },
        { attempts: 2, baseDelayMs: 1, backoffFactor: 1 }
      )
    ).rejects.toThrow('always fails');
    expect(attempts).toBe(2);
  });
});
