# Trakko workspace

This directory contains the merged Trakko application and its Telegram bot.

## Layout

```text
trakko/
├── trakko-assist/   # complete merged browser and backend application
└── telegram-bot/    # Telegram bridge and bot source
```

## Merge policy

`trakko-assist` was assembled from:

1. the existing `/Users/nilufa.islam/trakko-assist` application as the baseline;
2. `/Users/nilufa.islam/zepto-shop` overlaid as the authoritative current implementation.

Files from `zepto-shop` win whenever the same relative path exists in both projects. Baseline-only files remain in place. This produces a complete working tree without Git conflict markers or unresolved file-level conflicts.

The application keeps its original internal folder structure, including `docs`, `e2e`, `lib`, `public`, `scripts`, `src`, `test`, and `tmp`.

## Security exclusions

The merged workspace excludes:

- local environment files, except the sanitized `.env.example` template;
- `.vercel` project bindings and `.oauth-client.json`;
- Git metadata;
- `node_modules`, Python virtual environments, and caches;
- generated browser assets, test output, and coverage output;
- Telegram `bridge_state.db`;
- macOS metadata.

No production environment values are required to inspect or share this workspace. Configure deployment secrets separately in Vercel.
