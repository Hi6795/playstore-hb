# Contributing

Use focused pull requests, strict TypeScript/C++17, explicit errors, no hidden warnings, and tests for behavior changes. Run `pnpm lint`, `pnpm test`, and `pnpm build`. First-party compiler warnings are errors. Pin new dependencies, document source/version/license/attribution, justify them in `docs/THIRD_PARTY_REVIEW.md`, and never commit secrets or Sony SDK material.

Code contribution and content submission are separate. A code reviewer cannot turn a fixture into published content. Game submissions use the admin workflow and require independent rights/package/hardware review. Never add a production game directly by pull request. Media must depict the actual reviewed game; no generated screenshots.

Security-sensitive changes to canonicalization, signatures, downloads, installation, authorization, or publication require threat-focused tests and a second reviewer. Preserve backward-compatible state migrations or document a safe recovery path.
