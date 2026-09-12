/**
 * The terms a broadcaster offers, priced per byte delivered.
 *
 * Identical in spirit to spigot's: the unit is `net.bytes_delivered.v1`, the meter is `octets`,
 * exact, tolerance zero. A stream is bytes over time, and the price is per byte, so a minute of a
 * higher-bitrate feed costs more than a minute of a lower one -- the bill tracks the actual data,
 * which is the honest thing for streaming.
 *
 * The babel size is the payment cadence. It should be a small fraction of a second of playback so
 * the per-chunk round trip never starves the buffer: at 320 kbps audio (~40 KB/s) a 16 KB babel is
 * about 0.4 s of sound, paid four times a second with a chunk or two buffered ahead.
 */
import { minimumTolerance, resolveMeter, type OfferTerms } from 'metered-protocol';

export const UNIT = 'net.bytes_delivered.v1';
export const METER = 'octets';
export const DEFAULT_BABEL_BYTES = 16 * 1024;

export class UnairableTerms extends Error {}

export interface TermsInput {
  network: string;
  sompiPerByte: number;
  babelBytes?: number;
  /** The most a single session may bill, in bytes -- how much stream a listener buys before a new session. */
  sessionBytes: number;
  responseWindowDaa?: number;
}

/** Build the Offer terms for a station. `maxBabels` bounds one session's total stream length. */
export function streamTerms(input: TermsInput): OfferTerms {
  if (!Number.isSafeInteger(input.sompiPerByte) || input.sompiPerByte < 1) {
    throw new UnairableTerms('price must be a whole number of sompi per byte, at least 1');
  }
  const babelUnits = input.babelBytes ?? DEFAULT_BABEL_BYTES;
  if (!Number.isSafeInteger(babelUnits) || babelUnits < 1) {
    throw new UnairableTerms('babel size must be a whole number of bytes, at least 1');
  }
  return {
    v: 1,
    scheme: 'metered',
    network: input.network,
    asset: 'KAS',
    unit: UNIT,
    meter: METER,
    unitPriceSompi: input.sompiPerByte,
    babelUnits,
    maxBabels: Math.max(1, Math.ceil(input.sessionBytes / babelUnits)),
    toleranceAbs: minimumTolerance(resolveMeter(METER, UNIT)),
    checkpointEvery: 0,
    responseWindowDaa: input.responseWindowDaa ?? 600,
  };
}

/** Sompi as KAS, for printing only. Never an amount that is signed or settled. */
export const kas = (sompi: number): string => (sompi / 1e8).toFixed(8).replace(/0+$/, '0');

/** What a given length of stream costs, so a listener can reason before it tunes in. */
export const costOf = (bytes: number, terms: OfferTerms): number => bytes * terms.unitPriceSompi;
