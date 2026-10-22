# Changelog

## 0.2.1

2026-10-22. All three packages move to 0.2.1 together.

- `norkey-vault build` removes its temporary build folder when the build fails, not only when it
  succeeds.
- `norkey-vault build --logo` now names the flag and the path when it cannot read the file, for
  example `--logo logo.svg: cannot read the file (ENOENT)`, instead of printing Node's raw error.
- The published packages no longer include source maps, which pointed at source files that are not
  in the package.
- `@norkey/client` and `@norkey/server` declare their types for TypeScript projects that use
  `moduleResolution` set to `node` or `node10`, so imports such as `@norkey/client/protocol` and
  `@norkey/server/postgres` resolve there. TypeScript 7 removed that setting, so this matters only
  on TypeScript 5 and 6.

## 0.2.0

2026-10-21. All three packages move to 0.2.0 together.

- `@norkey/client` takes `viem` as a peer dependency (`^2.55.4`) instead of a dependency, so the app
  installs `viem` once and uses one copy. Install it next to the client: `npm install @norkey/client viem`.
- `@norkey/server` changes only its version. `@norkey/vault` keeps `viem` as a dependency, and its
  dependency on `@norkey/client` moves to 0.2.0.

## 0.1.0

First release of `@norkey/client`, `@norkey/server` and `@norkey/vault`.
