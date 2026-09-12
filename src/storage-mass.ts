/**
 * Kaspa's KIP-9 storage-mass guard for a channel claim.
 *
 * A `claim` spends the escrow into a *covenant* continuation, and consensus charges a covenant
 * output several times what a plain one costs. So a claim that would leave only a small float
 * behind in the escrow is refused by the node -- the escrow must stay large relative to any single
 * claim. This turns the node's opaque "storage mass too large" into a number and a plain
 * instruction an operator can act on, and lets a claim fail BEFORE it is broadcast.
 */
import type { Channel } from 'metered-protocol/rail';

/** Kaspa refuses a transaction whose storage mass exceeds this (KIP-9). */
export const STORAGE_MASS_LIMIT = 500_000n;
const K = 1_000_000_000_000n;

/**
 * Would this claim be refused by consensus for storage mass, in plain terms, or null if it is fine.
 *
 * It models the two claim outputs (a plain payout, plurality 1, and the covenant continuation,
 * plurality 2) against the covenant input (plurality 2) -- the KIP-9 relaxed formula the node uses.
 *
 * It is a CONSERVATIVE estimate: it errs high (for the live 10M-sompi / 6M-claim case it reads
 * ~966,750 where the node measured 781,818), so it never lets through a claim the node would then
 * reject; at worst it asks for a slightly larger channel than strictly needed. It is a plain-English
 * pre-flight, not consensus reproduced to the sompi.
 */
export function claimTooSmall(channel: Channel, claimSompi: bigint, feeSompi: bigint): string | null {
  const server = claimSompi - feeSompi;
  const cont = channel.active.amount - claimSompi;
  if (server <= 0n || cont <= 0n) return 'the claim does not leave a positive payout and continuation';
  // harmonic outs (payout plurality 1, continuation covenant plurality 2) minus arithmetic ins
  // (covenant input plurality 2). Integer division mirrors the node's own arithmetic.
  const harmonicOuts = (K * 1n * 1n) / server + (K * 2n * 2n) / cont;
  const arithmeticIns = 2n * (K / channel.active.amount);
  const mass = harmonicOuts > arithmeticIns ? harmonicOuts - arithmeticIns : 0n;
  if (mass <= STORAGE_MASS_LIMIT) return null;
  return `this claim would leave only ${cont} sompi in the escrow; a covenant output that small `
    + `exceeds Kaspa's storage-mass limit (mass ~${mass} > ${STORAGE_MASS_LIMIT}). Claim less at `
    + `once, or open a larger channel -- the escrow must stay well above what you claim.`;
}
