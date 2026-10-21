# Security model

This page explains how NorKey keeps a wallet key away from your server and your app page, what your
server holds, and the limits NorKey states up front. Read it before real funds go into a wallet.

## The key model

Each wallet has one key. The boundary page generates it with the platform's cryptographically
secure random number generator.

The server stores the key only as wraps. A wrap is the key encrypted with AES-GCM under a
key-encryption key (KEK) that comes from one passkey:

- The KEK is `HKDF-SHA256` over the passkey's PRF output, with a random salt for each wrap and the
  info string `norkey/wrap/v1`.
- The PRF input is one fixed value, `norkey/prf/v1`. A discoverable login can then evaluate PRF
  before the page knows which credential the user picked. The per-wrap salt goes into HKDF.
- The AES-GCM associated data is the user id, the wallet address and the wrap id. A wrap cannot be
  replayed under another user or wallet.
- After every unwrap, the page checks that the key's address matches the stored address, and
  refuses to sign if it does not.

A wallet can have several wraps of the same key, one per passkey. A passkey in iCloud Keychain and
one in Google Password Manager each get their own wrap, so both open the same wallet. A hardware
security key gets one the same way. Every wrap is a passkey wrap. There is no recovery wrap.

The wallet key and each KEK exist only for one operation, and the page zeroes them after it. No
message between the boundary page and the app carries either one.

The first send on each chain carries an EIP-7702 authorization to the configured Calibur address.
Later sends on that chain do not.

## What the server holds

The server stores ciphertext only, each wrap under a KEK derived from one passkey's PRF output. A
database leak yields nothing usable.

## The boundary page

The wallet key sits in boundary-page memory for the length of one gesture. Same-origin isolation
keeps the app page out.

Cross-site scripting (XSS) on the app page can still request signatures. The defenses are the
consent screen and the passkey gesture.

## The boundary page is the crown jewel

A server breach can serve a tampered boundary page. The next gesture on that page would leak the
wallet key. Hosting the boundary page is the most valuable thing to protect in a NorKey setup.

## Stated limits

- **Lost passkeys.** A user who loses every passkey that holds a wrap loses access through NorKey.
  The server cannot help, by design. The funds stay at the address, and only a user who exported the
  key can still move them.
- **A lapsed domain.** If the domain lapses, users who did not export the key lose access through
  NorKey. The funds stay at the address, and anyone who holds the key can still move them.
- **The developer who owns the domain is trusted.** It is their app.
- **Device malware** is out of scope.

## Custom auth mode

In [custom auth mode](custom-auth.md), the developer's `getUserId` decides who the user is. The
developer is still trusted. What changes is who can start a passkey ceremony.

- **A stolen app session, against a user who has a wallet.** Refused. Every wrap release, wallet
  creation and passkey add also needs a passkey assertion, verified against a credential of that
  user. The server also refuses to register a new passkey for an app user who already has a wallet.
- **A stolen app session, before the user's first use of NorKey (no NorKey user yet).** Registration has no passkey to check
  yet, so it relies on the app session alone. An attacker who holds the user's app session can
  register their own passkey and wallet under that app account. The user then reaches the unlock
  screen and cannot open the wallet. No funds are at risk, since the wallet is the attacker's own,
  but the account is squatted. This is the same power the stolen session already gives over the app
  itself. NorKey does not prevent it in code. The app can free the account by deleting the NorKey
  user and its rows, if the wallet is empty: see
  [Free a squatted account](custom-auth.md#free-a-squatted-account).
- **A stolen app session, against an app user who has a NorKey user but no wallet yet.** It can
  register a passkey on that user. Nothing is at risk, since there is no key yet.
- **A stolen NorKey session alone.** Refused, because `getUserId` must agree on the user.
- **A wrong `getUserId`.** If the developer's hook returns the wrong user, NorKey releases that
  user's wrap to a page that still needs that user's passkey to open it. The wrap is ciphertext.
  The hook is the developer's code, and it decides who the user is.
- **Two app accounts on one device.** The passkey picker shows only the signed-in app user's
  passkeys, and the server refuses another user's credential.

The mode is chosen once per database. Passkey-mode users have a null `external_id`, and custom mode
finds users only by `external_id`. A developer who switches a database from passkey mode to custom
mode loses access to the existing users through NorKey. Nothing detects this in code.
