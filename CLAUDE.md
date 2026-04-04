# CLAUDE.md – Ladefuchs Deploy-Regeln

## Bei jedem Git Push / Deploy

1. Versionsnummer in `index.html` hochzählen bei ALLEN Asset-Links:
   - `<script src="script.js?v=X.Y.Z"></script>`
   - `<link rel="stylesheet" href="styles.css?v=X.Y.Z">`
   - Patch-Version +1 bei Bugfixes (1.2.0 → 1.2.1)
   - Minor-Version +1 bei neuen Features (1.2.0 → 1.3.0)

2. Commit-Message soll die Version enthalten, z.B.:
   `fix: Ersparnis-Chip in History-Liste v1.3.1`

## Warum

Safari/iOS cached Assets sehr aggressiv. Ohne Versionsnummer
sehen Nutzer nach einem Deploy noch die alte Version.
