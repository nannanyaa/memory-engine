# Contributing

Thanks for your interest in contributing to **memory-engine**! This project started as a personal-team build and is now open — all reasonable contributions are welcome.

## Code of conduct

Be kind. Treat every contributor with respect regardless of experience or background. Unconstructive or harassing behavior is not tolerated.

## How to contribute

### 1. Reporting issues / requesting features

- Search existing issues first — someone may have already filed it.
- Open an issue with a clear title and:
  - For **bugs**: steps to reproduce, expected vs actual behavior, plugin version, OpenClaw version, OS.
  - For **features**: the problem you're trying to solve, not just a desired solution.

### 2. Submitting code (pull requests)

1. Fork the repo and create a branch: `git checkout -b feat/your-change`.
2. Make your change. Follow the module conventions below.
3. Run locally:
   ```bash
   npm ci
   npm run typecheck   # may need the OpenClaw SDK (peer dep) for plugin-entry types
   npm run build
   node test/run-tests.mjs   # unit + algorithm matrix (temp dir, never touches production DBs)
   ```
4. Add/update tests if you touch logic.
5. Open a PR against `main`, referencing the issue it fixes.

### 3. Adding or tuning a module — the three-step pattern

- Add an `enable_<name>` switch (default `false`) in `src/config.ts`.
- Implement the module as pure functions + background tasks (never `await` network/LLM inside a hook).
- Register the corresponding hook/tool/cron in `src/registry.ts`.

### 4. Tuning thresholds / defaults

- Change field defaults in `normalizeConfig` (`src/config.ts`), and **also sync `openclaw.plugin.json`'s `configSchema`** so the CLI/Web panel exposes them.
- Always update this README's config table with the field's rationale (we maintain the README as a design-decision manual).

## Iron rules

1. **Never block the message path** — heavy work must go to the background.
2. **Back up and stay rollback-able** before any compaction/write change.
3. **Never touch mechanism files** — don't grab the contextEngine/memory slot, don't rewrite agent mechanism files.

These are enforced in review; PRs that ignore them may be asked to revise.

## Mailing the maintainer

For larger designs or security matters, reach out first (see SECURITY.md for security; for general questions open a Discussion/issue).
