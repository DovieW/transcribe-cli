# Contributing

Issues and focused pull requests are welcome.

## Local setup

```bash
npm ci
npm test
npm run check
npm run build
```

Keep provider tests offline by mocking `fetch`; the automated suite must never
need a real API key. Add tests for behavior changes and keep credentials,
recordings, transcripts, and local database files out of commits.

For provider changes, link the provider's current primary documentation in the
pull request and describe any request-shape or model-availability assumptions.

## Pull requests

- Keep each pull request narrowly scoped.
- Explain user-visible behavior and migration impact.
- Confirm `npm test`, `npm run check`, and `npm run build` pass.
- Do not include generated `dist/` files; releases build binaries in CI.
