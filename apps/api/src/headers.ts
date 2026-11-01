// SEC §10 baseline. In AWS the load balancer sends /api/* straight to the API (ARCH §2), so API
// responses can't rely on the dashboard's headers. JSON is never a page: it may not be framed,
// sniffed as HTML, or run anything. The realtime stream writes these itself (it bypasses onSend).
export const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'referrer-policy': 'no-referrer',
} as const;
