import type { Address, Hex } from 'viem'

/** 0 DEFAULT, 1 VERIFY, 2 SENDER. Mode 5 (UTXO, EIP-8312) is inert on this chain. */
export type FrameMode = 0 | 1 | 2

/** 0 ARBITRARY, 1 SECP256K1, 2 P256. */
export type SigScheme = 0 | 1 | 2

/** EIP-8141 `limits`, always encoded as a two-element list. */
export type FrameLimits = {
  execution: bigint
  /** EIP-8037 state gas. */
  state: bigint
}

export type Frame = {
  mode: FrameMode
  /** Bits 0-1 APPROVE scope, bit 2 atomic batch, bits 3-7 reserved and zero. */
  flags: number
  /** `null` means "use tx.sender". */
  target: Address | null
  limits: FrameLimits
  /** Must be zero unless the frame is SENDER. */
  value: bigint
  data: Hex
}

export type FrameSignature = {
  scheme: SigScheme
  /** `null` resolves to tx.sender for SECP256K1/P256; MUST be null for ARBITRARY. */
  signer: Address | null
  /** '0x' is the canonical sig-hash case; otherwise a 32-byte digest. */
  msg: Hex
  /** SECP256K1: v||r||s, 65 bytes, v a bare recovery id. P256: r||s||qx||qy, 128 bytes. */
  signature: Hex
}

export type FrameTransaction = {
  chainId: bigint
  /**
   * EIP-8250 nonce keys: 1 to 16, strictly increasing, each a uint256. `[0n]` is
   * the sender's ordinary account nonce; key `0` is valid only as the sole key.
   * Non-zero keys are tracked in the `NONCE_MANAGER` predeploy.
   */
  nonceKeys: bigint[]
  /** EIP-8250 sequence number, a uint64 matched against every selected key. */
  nonceSeq: bigint
  sender: Address
  frames: Frame[]
  signatures: FrameSignature[]
  maxPriorityFeePerGas: bigint
  maxFeePerGas: bigint
  maxFeePerBlobGas: bigint
  blobVersionedHashes: Hex[]
}

/**
 * Which rule set to price under.
 * Kept for API compatibility with the kit's gas helpers. hegota-testnet prices
 * every frame transaction under one set of rules, so all three names are aliases.
 */
export type RuleSet = 'chain' | 'pins' | 'head'
