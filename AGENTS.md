# Working in this repository

- Use Node.js 24 (exact version in `.node-version`). Install with `npm ci`; do not add dependencies casually.
- `npm run check` is the canonical verification: type-check, clean build, all tests. Run it before
  claiming a change works. CI runs the same command.
- `npm test` rebuilds `dist/` and `dist-test/` and runs the compiled tests with `node --test`.
- Source is in `src/`, tests in `test/`. The CLI entry point is `dist/cli.js`.
- Lending rules live in `src/desk.ts` and validation in `src/validation.ts`; the CLI and dashboard only
  call into them. Keep business rules out of `src/cli.ts` and `src/dashboard.ts`.
- `docs/behavior-v0.md` is the behavior contract (rules, CLI syntax, JSON, error codes, schema). Update it
  with any intentional behavior change, and keep existing v0 databases readable.
- Tests must use temporary databases, stay deterministic (inject a clock; never sleep to separate
  timestamps), and clean up only what they create.
- Never commit databases, `dist/`, `dist-test/`, `demo-output/` or generated reports.
