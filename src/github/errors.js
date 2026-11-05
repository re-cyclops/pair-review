// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * Custom error class for GitHub API errors that preserves the HTTP status code.
 * Route handlers can check `error.status` or use `instanceof GitHubApiError`
 * instead of fragile string matching on error messages.
 */
class GitHubApiError extends Error {
  /**
   * @param {string} message - Human-readable error message
   * @param {number} status - HTTP status code (e.g. 401, 403, 404, 429)
   */
  constructor(message, status) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

/** GitHub's pre-execution complexity/cost rejection. */
function isComplexityError(error) {
  const patterns = [/complexity/i, /MAX_NODE_LIMIT/, /cost exceeds/i, /too large/i, /query size exceeds/i];
  return patterns.some(pattern => pattern.test(error.message || '')) ||
    Array.isArray(error.errors) && error.errors.some(item => patterns.some(pattern => pattern.test(item.message || '')));
}

module.exports = { GitHubApiError, isComplexityError };
