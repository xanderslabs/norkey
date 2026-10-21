# Changelog

## 0.2.0

2026-10-21. All three packages move to 0.2.0 together.

- `@norkey/client` takes `viem` as a peer dependency (`^2.55.4`) instead of a dependency, so the app
  installs `viem` once and uses one copy. Install it next to the client: `npm install @norkey/client viem`.
- `@norkey/server` changes only its version. `@norkey/vault` keeps `viem` as a dependency, and its
  dependency on `@norkey/client` moves to 0.2.0.

## 0.1.0

First release of `@norkey/client`, `@norkey/server` and `@norkey/vault`.
