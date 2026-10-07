# frametx-kit

[![npm](https://img.shields.io/npm/v/%40jaw.id%2Fframetx-kit)](https://www.npmjs.com/package/@jaw.id/frametx-kit)
[![CI](https://github.com/JustaLab-co/frametx-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/JustaLab-co/frametx-kit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/JustaLab-co/frametx-kit/badge)](https://scorecard.dev/viewer/?uri=github.com/JustaLab-co/frametx-kit)

TypeScript for the **EIP-8141 frame transaction** envelope, with EIP-8250 keyed nonces,
as the Ethrex hegota-testnet (chain ID `8141`) accepts it.

Decode, build, hash, sign, price, dry-run and broadcast.

## Install

```bash
bun add @jaw.id/frametx-kit viem
```

`viem` is a peer dependency, not a bundled one. `frameActions` extends a viem client, so
your client and this library have to be the same viem.

## Use

```ts
import { createPublicClient, http } from 'viem'
import { hegotaTestnet } from '@jaw.id/frametx-kit'
import { frameActions } from '@jaw.id/frametx-kit/viem'

const client = createPublicClient({
  chain: hegotaTestnet,
  transport: http(),
}).extend(frameActions)

const tx = await client.getFrameTransaction({ hash })
const receipt = await client.getFrameTransactionReceipt({ hash })
```

For the common build-sign-send path, use the standalone high-level action. `value`, `data`,
nonce selection, and fee reads have defaults. Frame limits are mandatory because the RPC
cannot currently estimate execution and state gas separately:

```ts
import { sendFrameTransaction } from '@jaw.id/frametx-kit'

const hash = await sendFrameTransaction(account, [
  { to: recipient, value: 1n },
], {
  limits: {
    validation: { execution: 30_000n, state: 0n },
    calls: [{ execution: 40_000n, state: 200_000n }],
  },
})
```

There must be one call-limit entry per call. A payer account is prepared and signed
automatically when supplied, and its limits are also mandatory:

```ts
const hash = await sendFrameTransaction(account, calls, {
  limits: {
    validation: { execution: 25_000n, state: 0n },
    calls: [{ execution: 150_000n, state: 250_000n }],
  },
  paymaster: {
    account: payer,
    limits: { execution: 25_000n, state: 200_000n },
  },
})
```

Building a transaction? Call `assertValidFrameTx(tx)` before `encodeFrameTx(tx)`. The
encoder itself does not validate, because `sig_hash` is defined over a re-encoding and a
validating encoder would reject the live chain data this library is meant to survey.

```ts
import { assertValidFrameTx, encodeFrameTx, signFrameTx } from '@jaw.id/frametx-kit'

const signed = await signFrameTx(tx, privateKey)
assertValidFrameTx(signed)
const raw = encodeFrameTx(signed)
```

`signFrameTx` also takes a `FrameAccountOwner` instead of a key. This includes viem's
`privateKeyToAccount` and `mnemonicToAccount`, a `toAccount` source, the tagged owner from
`privateKeyToP256Account`, and viem accounts backed by hardware wallets, HSMs or remote signers.
It signs every ECDSA entry whose `msg` is empty and refuses if either the signature scheme
or resolved signer does not match the supplied owner.

```ts
import { privateKeyToAccount, toAccount } from 'viem/accounts'

const signed = await signFrameTx(tx, privateKeyToAccount(privateKey))

// Wrap a remote signer as a viem Account:
const remoteAccount = toAccount({
  address: '0x…',
  sign: ({ hash }) => myKms.signDigest(hash), // r||s||v, v as 27/28 or a bare 0/1
})
const signed = await signFrameTx(tx, remoteAccount)
```

A raw-digest `sign` is required. `signMessage` will not do: it EIP-191-prefixes its
argument, so the signature recovers to nothing. A `JsonRpcAccount` (a browser wallet)
cannot sign a raw digest at all — both are refused with an error rather than producing a
transaction the chain silently rejects.

The same restriction applies to P-256 signers. WebCrypto's ECDSA API hashes its input
internally, so passing the frame sig-hash to it signs `SHA-256(frameSigHash)`, not the
frame sig-hash itself. Passkeys/WebAuthn sign authenticator data and client data rather
than an arbitrary 32-byte digest. Use a P-256 backend that explicitly supports raw or
prehashed ECDSA digests; `privateKeyToP256Account` does so for a local private scalar.

ARBITRARY entries are left untouched; build those signatures yourself and let
`assertValidFrameTx` check them. The low-level `signFrameTx` handles one owner and
signature scheme at a time; `signFrameTransaction` coordinates a sender and an optional
`FramePayerAccount`.

For an EIP-7702 delegated account authorized by P-256, create a signer from its raw
32-byte private scalar and resolve the delegated EOA separately. P-256 signatures are
made directly over the frame sig-hash, normalized to low `s`, checked locally, and encoded
as `r || s || qx || qy`.

```ts
import {
  privateKeyToP256Account,
  toP256FrameAccount,
} from '@jaw.id/frametx-kit'

const owner = privateKeyToP256Account(p256PrivateKey)
const account = await toP256FrameAccount({
  client,
  address: delegatedEoa,
  owner,
})
```

To exercise a PEM-backed delegated account end to end against the Ethrex testnet:

```bash
RPC_URL=https://rpc1.privacy.ethrex.xyz \
SENDER=0x... \
RECIPIENT=0x... \
P256_PRIVATE_KEY_PATH=/absolute/path/to/p256-private.pem \
bun run scripts/send-eth-p256.ts
```

The script checks that the PEM-derived identity equals the delegated account's on-chain
`p256Signer()`, then sends through the high-level `sendFrameTransaction` action.

Sending walks the strict path for you — `assertValidFrameTx`, `encodeFrameTx`,
`eth_sendRawTransaction` — and checks that the hash the node returns is `keccak256` of the
bytes it was given. The receipt wait is frame-aware: a skipped frame comes back as
`'skipped'`, not as a revert.

```ts
const hash = await client.sendFrameTransaction({ transaction: signed })
const receipt = await client.waitForFrameTransactionReceipt({ hash })
```

Passing every check here does not guarantee admission. The VERIFY prefix must `APPROVE`
payment, and the payer must hold the transaction's `maxCost`, or the frame reverts. A
code-less EOA gets that from the protocol's default code, which `toEoaFrameAccount` targets;
anything else needs its own validating contract. Dry-run with
`client.simulateFrameTransaction({ raw })` before spending.

To use a separate codeless EOA payer, resolve it from a raw-digest-capable account and pass
it through preparation and signing:

```ts
const payer = await toEoaFramePayerAccount({
  owner: privateKeyToAccount(payerPrivateKey),
})

const transaction = await prepareFrameTransaction(account, calls, limits, {
  paymaster: {
    account: payer,
    limits: { execution: 60_000n, state: 200_000n },
  },
})

const signed = await signFrameTransaction(account, transaction, { payer })
```

This changes the validation prefix from `self_verify` to `only_verify -> pay`. The
sender signs outer signature index `0`; the EOA payer signs the protocol-reserved payment
signature at index `1`. Both entries are installed during preparation, before either
signature is produced, so both signatures commit to the same transaction hash. Custom
contract payers can be defined with `toFramePayerAccount` to provide their PAY calldata,
signature entries, and signing behavior.

## Nonces are keyed

A transaction carries `nonceKeys` and one `nonceSeq` (EIP-8250), not a scalar `nonce`.
`[0n]` is the ordinary account nonce and is what `prepareFrameTransaction` uses by
default. Any other key lives in the `NONCE_MANAGER` predeploy; `getFrameNonceSeq` reads
either kind, and `prepareFrameTransaction(account, calls, limits, { nonceKeys: [1n, 2n] })`
selects several, provided they currently sit at the same sequence.

The first use of a non-zero key costs `KEYED_NONCE_FIRST_USE_STATE_GAS` (97,920) of state
gas, charged against the payment-approving frame's `limits.state`. Budget for it.

## Two things that will bite you

**Frame receipt status is three-valued** — `'failure'`, `'success'`, `'skipped'`. A
skipped frame never executed and its gas was refunded. It is not a revert.

**The chain's public RPC serves no raw transaction bytes.** `getFrameTransaction` reads
the node's decoded JSON, re-encodes it, and refuses to return anything whose re-encoding
does not reproduce the transaction hash. What you get back is a transaction this library
can put back on the wire byte-for-byte.

## Gas

`frameTxGas` prices a transaction from its declared limits, including EIP-8250's nonce
calldata, and `frameTxMaxCost` gives the most it can cost the payer.

```ts
import { frameTxGas, frameTxMaxCost } from '@jaw.id/frametx-kit'
const { intrinsicGas, maxGas } = frameTxGas(tx)
const maxCost = frameTxMaxCost(tx, blobBaseFee)
```

Every gas constant is written as its published figure rather than derived. ethrex's own
suite missed its intrinsic dropping from 15000 to 12000 across 1372 tests by deriving the
expected value from the constant under test.

## Tests

```bash
bun run test        # hermetic, no network
bun run typecheck
```

The default suite is hermetic. Its golden RLP and signature hash are pinned to the
current Ethrex `FrameTransaction` encoder.

## Contributing

Contributions welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first — this wire format
has traps, and several things in `src/` that look like code smells are load-bearing.

The most valuable report is a disagreement with the reference client. If this library and
ethrex produce different bytes, a different hash, a different price or a different receipt,
open a [divergence report](https://github.com/JustaLab-co/frametx-kit/issues/new?template=01-divergence.yml)
with the transaction hash or the byte vector. That is what a second implementation is for.

Anything that could let a transaction be authorised for something other than what it says
goes to [`SECURITY.md`](SECURITY.md) and a private advisory instead of a public issue.

Looking for somewhere to start? The issues labelled
[good first issue](https://github.com/JustaLab-co/frametx-kit/issues?q=is%3Aopen+label%3A%22good+first+issue%22)
are the coverage gaps that need a captured transaction rather than a design decision.

## Docs

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — architecture, invariants, wire-format traps, how
  the tests work
- [`docs/DESIGN.md`](docs/DESIGN.md) — the binding design spec
- [`SECURITY.md`](SECURITY.md) — what counts as a vulnerability here, and how to report it
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — expected conduct in issues and pull requests

## License

MIT
