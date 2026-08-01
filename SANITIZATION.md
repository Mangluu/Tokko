# Sanitized source copy

This directory is a credential-free copy of the Trakko Assist application.

The copy intentionally excludes:

- `.env`, `.env.local`, and environment-specific local files
- `.vercel` project linkage and deployment metadata
- generated OAuth client registration files
- installed `node_modules`
- Playwright reports and test-result artifacts
- cookies, private keys, local databases, and logs

`.env.example` contains placeholders and localhost or example-domain URLs only.
Test fixtures may contain clearly non-production test identifiers.

To run the project:

```bash
cp .env.example .env.local
npm ci
npm test
npm run build
```

Fill `.env.local` with credentials from your own development or sandbox
accounts. Never commit that file.
