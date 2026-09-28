'use strict';

const DEFAULT_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 30000);
const DEFAULT_ATTEMPTS = Number(process.env.HTTP_ATTEMPTS || 3);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shouldRetryStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function fetchWithRetry(url, options = {}, config = {}) {
  const attempts = config.attempts || DEFAULT_ATTEMPTS;
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!shouldRetryStatus(response.status) || attempt === attempts) return response;
      if (response.body) await response.body.cancel();
      lastError = new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
    } catch (err) {
      lastError = err;
      if (attempt === attempts) break;
    }

    await delay(500 * (2 ** (attempt - 1)));
  }

  throw new Error(`Request failed after ${attempts} attempts for ${url}: ${lastError.message}`);
}

module.exports = { fetchWithRetry };
