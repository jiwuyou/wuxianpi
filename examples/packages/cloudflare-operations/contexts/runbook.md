# Cloudflare operations runbook

- Identify the account and zone before any mutation.
- Retrieve the current resource and preserve values outside the requested scope.
- Treat asynchronous deployment and certificate operations as pending until the
  API reports a terminal state.
- Return a concise fallback-text summary with every structured result.
