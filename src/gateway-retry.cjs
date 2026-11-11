'use strict';

function failureCategory(error) {
  const code = error?.cause?.code || error?.code;
  if (error?.name === 'AbortError' || /TIMEOUT/.test(code || '')) return 'timeout';
  if (error?.status) return `http:${error.status}`;
  if (code === 'GATEWAY_CONFIG') return 'configuration';
  if (code === 'INVALID_USAGE') return 'response';
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE'].includes(code)
      || error?.name === 'TypeError') return 'connection';
  return `unexpected:${error?.name || 'Error'}`;
}

// Categories are remembered for the entire outage, not just the last error:
// refused -> timeout -> refused must not produce a fresh log on every retry.
class GatewayRetry {
  constructor(initialMs, maximumMs) {
    this.initialMs = initialMs;
    this.maximumMs = maximumMs;
    this.reset();
  }

  reset() {
    this.failures = 0;
    this.retryAt = 0;
    this.categories = new Set();
  }

  ready(now) { return now >= this.retryAt; }

  fail(error, now) {
    const category = failureCategory(error);
    const report = !this.categories.has(category);
    this.categories.add(category);
    this.failures = Math.min(this.failures + 1, 16);
    const wait = Math.min(this.initialMs * 2 ** (this.failures - 1), this.maximumMs);
    this.retryAt = now + wait;
    return { report, wait };
  }

  recover() {
    const recovered = this.failures > 0;
    this.reset();
    return recovered;
  }
}

module.exports = { GatewayRetry };
