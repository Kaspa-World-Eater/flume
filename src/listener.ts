/**
 * The buying half: tune in, pull the stream a chunk at a time, and pay for the BYTES that arrive.
 *
 * A note on "per second": flume meters delivered bytes and the elapsed request time, not decoded
 * seconds of media. `playMs` bounds how long it keeps pulling; it does not bill by playback time. A
 * codec-aware pay-per-second product would sit on top of this, converting seconds to byte ranges.
 *
 * The one property that makes streaming different from buying a file: **the listener decides when
 * to stop, and stops paying at that byte.** No plan, no cancellation, no minimum. `tune` pulls
 * chunks until the caller says stop, the station ends, or the money runs out -- and whichever comes
 * first, the listener has paid for exactly what it received and not one byte more.
 *
 * A live edge is not the end. When a live station has no new bytes yet, the chunk comes back empty
 * (the broadcaster billed nothing for it, because nothing arrived), and `tune` waits a beat and
 * asks again. Only an explicit end from the broadcaster, or the caller's own `stop`, ends the loop.
 */
import { openSession, runBabel, meterFor, type BuyerSession, type ChannelProposal } from 'metered-protocol';
import { encodeAsk } from './ask.js';
import { GUIDE_PATH } from './broadcaster.js';

export class OffTheAir extends Error {}

export interface Guide {
  stations: { name: string; kind: 'on-demand' | 'live'; available: number; floor: number; closed: boolean }[];
  terms: { unit: string; meter: string; unitPriceSompi: number; babelUnits: number; network: string; responseWindowDaa: number };
  providerPubkey: string;
}

export interface TuneReceipt {
  station: string;
  bytesPlayed: number;
  sompiSpent: number;
  chunks: number;
  /** Why the loop ended: the caller stopped, the station closed, or the funds could not cover more. */
  until: 'stopped' | 'ended' | 'exhausted';
  settlement: { covenantId: string; vouchedSompi: number } | null;
}

/** Read the guide of what a broadcaster has on the air. Unpaid: deciding to tune requires seeing it. */
export async function readGuide(base: string): Promise<Guide> {
  const res = await fetch(`${base}${GUIDE_PATH}`);
  if (!res.ok) throw new OffTheAir(`guide unavailable: HTTP ${res.status}`);
  return await res.json() as Guide;
}

export interface TuneOptions {
  base: string;
  listenerSk: string;
  station: string;
  /** Called with each chunk as it arrives. May return a promise; it is awaited, so an async decoder
   *  or sink can apply backpressure -- the next paid chunk is not pulled until this resolves. */
  onBytes: (chunk: Uint8Array) => void | Promise<void>;
  /** Return true to stop. Checked before every chunk -- this is how a listener leaves at any moment. */
  stop?: () => boolean;
  /** Stop after this many ms OF PLAYBACK. The clock starts once tuned in, not during the handshake. */
  playMs?: number;
  /** How long to wait at a live edge before asking again, ms. */
  liveGapMs?: number;
  expectedNetwork?: string;
  /** A channel this listener holds with the broadcaster, to pay through (SPEC.md 3.5). */
  channel?: ChannelProposal;
  /** Start pulling from this absolute source offset (resume). Default: a live feed's retained floor,
   *  or 0 for a recording. */
  fromOffset?: number;
}

/**
 * Tune in and play until stopped.
 *
 * The offset only ever moves by what actually arrived, so a stall costs nothing and a reconnect is
 * free. Payment is per chunk, off-chain, through metered's session; the broadcaster claims on chain
 * whenever it likes.
 */
export async function tune(opts: TuneOptions): Promise<{ receipt: TuneReceipt; session: BuyerSession }> {
  const guide = await readGuide(opts.base);
  const entry = guide.stations.find((st) => st.name === opts.station);
  if (!entry) throw new OffTheAir(`nothing on the air called ${JSON.stringify(opts.station)}`);
  const meter = meterFor(guide.terms.meter, guide.terms.unit);
  const { offer, session } = await openSession(opts.base, opts.listenerSk, meter, opts.expectedNetwork, undefined, opts.channel);

  // A RECORDING HAS A KNOWN LENGTH; a live feed does not. For on-demand, the end is exactly the
  // guide's length -- no waiting. For live, the end can only be discovered by asking and finding
  // nothing new, again and again, until the feed is clearly over.
  const fixedLength = entry.kind === 'on-demand' ? entry.available : null;
  const gap = opts.liveGapMs ?? 250;
  // A late listener cannot start below a live feed's retained floor; a recording resumes wherever asked.
  const startOffset = opts.fromOffset ?? (entry.kind === 'live' ? entry.floor : 0);
  // The playback clock starts NOW -- after the session and any channel verification, not during
  // them -- so "listen for 3 seconds" means three seconds of stream, not three seconds that a slow
  // handshake could eat before a single byte arrived.
  const deadline = opts.playMs ? Date.now() + opts.playMs : Infinity;
  let offset = startOffset;
  let chunks = 0;
  let until: TuneReceipt['until'] = 'ended';

  while (true) {
    if (opts.stop?.() || Date.now() >= deadline) { until = 'stopped'; break; }
    if (fixedLength !== null && offset >= fixedLength) { until = 'ended'; break; }

    let outcome;
    try {
      outcome = await runBabel(opts.base, session, encodeAsk({ name: opts.station, offset }));
    } catch (err) {
      // A halt on disagreement, or funds that cannot cover another chunk, ends the listen -- the
      // listener keeps what it already paid for and played.
      if (isExhausted(err)) { until = 'exhausted'; break; }
      throw err;
    }

    if (outcome.content.length === 0) {
      // Empty means "nothing new right now" OR "the feed is over" -- and those are different. Ask the
      // guide (unpaid) which it is: only an explicitly CLOSED station we have caught up to is the end.
      // A live feed that is merely quiet is not; we wait at the edge without buying empty chunks.
      const cur = (await readGuide(opts.base)).stations.find((st) => st.name === opts.station);
      if (cur && cur.closed && offset >= cur.available) { until = 'ended'; break; }
      await new Promise((r) => setTimeout(r, gap));
      continue;
    }

    await opts.onBytes(outcome.content);
    offset += outcome.content.length;
    chunks += 1;
  }

  return {
    session,
    receipt: {
      station: opts.station,
      bytesPlayed: offset - startOffset, // bytes actually delivered this listen, not the absolute edge
      sompiSpent: session.spentSompi,
      chunks,
      until,
      settlement: offer.channel ?? null,
    },
  };
}


const isExhausted = (err: unknown): boolean =>
  err instanceof Error && /funds|cover|exhaust|babelUnits|maxBabels/i.test(err.message);
