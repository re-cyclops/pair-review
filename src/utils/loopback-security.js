// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const isAllowedHost = value => {
  if (typeof value !== 'string' || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(value)) return false;
  try { new URL(`http://${value}`); return true; } catch { return false; }
};
const isAllowedOrigin = value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && isAllowedHost(url.host)
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
};
const allowedUpgrade = request => isAllowedHost(request.headers.host)
  && (request.headers.origin == null || isAllowedOrigin(request.headers.origin));
const rejectUnsafeRequest = (req, res, next) => {
  if (!isAllowedHost(req.headers.host)) return res.status(403).json({ error: 'Requests must use a loopback Host header' });
  // Some existing GET routes provision a checkout, so method alone is not a safe exemption
  if ((req.headers.origin != null && !isAllowedOrigin(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') {
    return res.status(403).json({ error: 'Requests must originate from the loopback application' });
  }
  next();
};
module.exports = { allowedUpgrade, isAllowedHost, isAllowedOrigin, rejectUnsafeRequest };
