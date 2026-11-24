// @ts-check
// Dream Cycle 2026-10-29 (developer-experience): first real lint gate for
// ruClip. Replaces the `npm run lint` no-op stub ("no lint config yet —
// scaffold stage") that always exits 0 regardless of code content.
//
// Scope and intent, kept deliberately narrow for a first, reviewable pass:
//   - typescript-eslint's `recommended` (type-checked-free) ruleset only —
//     not `strict`/`stylistic`, to avoid a large first-night finding count
//     that would have to be silently auto-fixed to stay small.
//   - Advisory only for now: wired into CI with `continue-on-error: true`
//     (see .github/workflows/ci.yml), mirroring the existing
//     `harness:advisory` precedent for metaharness score/genome/mcp-scan.
//     Promoting it to a hard gate is a separate, future decision once a
//     human has reviewed the first finding count.
//   - No source files were modified to satisfy this config — it is a
//     pure, additive, read-only diagnostic for tonight's run.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.harness/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // This repo is Node-only (package.json "type": "module", no browser
    // target) — scripts/*.mjs and the CLI entry use Node globals
    // (process, console) that `js.configs.recommended` doesn't know about
    // on its own.
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      // Scaffold-stage repo: several modules intentionally use `any` at
      // MCP/bridge boundaries (untyped third-party tool responses). Keep
      // this a warning, not an error, for the first pass rather than
      // silencing it outright.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
