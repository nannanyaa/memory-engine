# Security Policy

## Reporting a Vulnerability

We take security issues seriously. Please **do not** open a public issue or PR for a security vulnerability.

**Report privately** by emailing the maintainer (address in the GitHub profile / release notes), or by opening a **private** security advisory via GitHub's "Report a vulnerability" button on this repo.

Please include:
- A description of the vulnerability and the affected version.
- Steps to reproduce (minimal, if possible).
- Any impact you have assessed.

We aim to acknowledge reports within **5 business days** and will keep you updated on the fix plan.

## Scope

This plugin **never** writes to `openclaw.json` / `AGENTS.md` / `MEMORY.md` / `USER.md` / `tasks` / `lcm.db` (lcm is read-only). It only writes its own `memory-engine.db` + append-only memory files, and always backs up before writing. Vulnerabilities are most likely to concern:

- **Prompt-injection via injected memory blocks** — the plugin injects memory text from your own workspace into context; a tampered workspace file could influence generations. Validate/trust your workspace sources.
- **LLM/embedding API key handling** — keys are passed as request headers only, never logged; but be careful where you store `openclaw.json`/config with keys.
- **Path traversal** — archive/write paths derive from configured `archiveDir`/`workspaceDir`; only give the plugin paths you control.

## Supported Versions

| Version | Supported |
| --- | --- |
| 0.1.x (beta) | ⚠️ Beta — best-effort security fixes, expect breaking changes |
| < 0.1.0 | ❌ Unsupported |

## Security best practices for users

- Keep API keys out of any committed config; use environment variables / secret managers.
- Run with the least privilege for `workspaceDir` required by your OpenClaw setup.
- Review workspace files (the memory source) as you would any input to your model.
