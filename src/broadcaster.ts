/**
 * The selling half: a `Deliver` that hands out the next bytes of a station.
 *
 * As with spigot, the entire application-specific part of the seller is one `Deliver`. metered
 * carries the 402, the reservation, the two counts, the signatures and the halt-on-disagreement;
 * this only decides which bytes a request refers to and reads them.
 *
 * THE DIFFERENCE FROM A FILE IS WAITING. A file always has the next byte ready. A live station may
 * not -- the listener has caught up to the edge and the next second of audio has not been produced
 * yet. So a request that asks past the available edge does not fail and does not return a wrong
 * count; it returns an empty delivery, and metered's own rule bills nothing for bytes that did not
 * arrive. The listener sees the empty chunk, waits, and asks again.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { MeteredService, meteredHandler, meterFor, type Deliver, type OfferTerms, type ServiceOptions } from 'metered-protocol';
import { decodeAsk } from './ask.js';
import { StationRewind, type Station } from './station.js';

/** Unpaid: you cannot decide to tune in to something you cannot see is on the air. */
export const GUIDE_PATH = '/flume/guide';

/** Serve the next bytes of whichever station a request names, from the offset it names. */
export function stationDeliver(stations: Map<string, Station>): Deliver {
  return (prompt: string, maxUnits: number): Uint8Array => {
    const ask = decodeAsk(prompt);
    const station = stations.get(ask.name);
    if (!station) throw new NoSuchStation(ask.name);
    // A rewind is the one hard error: the listener asked for bytes that no longer exist. Everything
    // else -- caught up to a live edge, at the end of a recording -- is an ordinary empty delivery.
    return station.read(ask.offset, maxUnits);
  };
}

export class NoSuchStation extends Error {
  constructor(name: string) {
    super(`nothing on the air called ${JSON.stringify(name)}`);
  }
}

export interface BroadcastOptions {
  stations: Station[];
  terms: OfferTerms;
  providerSk: string;
  providerPubkey: string;
  /** Verify a channel a listener proposes (SPEC.md 3.5). Absent, sessions run unpaid. */
  channelFor?: ServiceOptions['channelFor'];
  sessions?: ServiceOptions['sessions'];
  /**
   * Override the meter. An HONEST broadcaster never sets this -- the meter must measure the unit
   * the terms name, and the default does. It exists so a test can build a DISHONEST broadcaster
   * whose meter overstates, and watch the listener's own count refuse it.
   */
  meter?: ServiceOptions['meter'];
}

interface GuideEntry {
  name: string;
  kind: Station['kind'];
  available: number;
  /** Lowest offset still retained -- where a late listener must start on a live feed. */
  floor: number;
  /** True once no more bytes will ever come (recording, or a live feed closed). */
  closed: boolean;
}

/**
 * An HTTP server that publishes a guide of what is on the air and streams what a listener tunes to.
 *
 * The guide is answered here; everything else is metered's. Note what the guide does NOT promise:
 * a length for a live station, or a digest of the whole thing. Those do not exist for a feed that
 * is still being made. A listener verifies each chunk as it arrives (metered does that), not the
 * whole broadcast at the end.
 */
export function broadcast(opts: BroadcastOptions): { server: Server; service: MeteredService } {
  const stations = new Map(opts.stations.map((s) => [s.name, s]));
  const service = new MeteredService({
    terms: opts.terms,
    providerSk: opts.providerSk,
    providerPubkey: opts.providerPubkey,
    meter: opts.meter ?? meterFor(opts.terms.meter, opts.terms.unit),
    deliver: stationDeliver(stations),
    ...(opts.channelFor ? { channelFor: opts.channelFor } : {}),
    ...(opts.sessions ? { sessions: opts.sessions } : {}),
  });

  const metered = meteredHandler({ service });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && (req.url ?? '') === GUIDE_PATH) {
      const guide: GuideEntry[] = opts.stations.map((s) => ({ name: s.name, kind: s.kind, available: s.available(), floor: s.floor(), closed: s.closed() }));
      const body = JSON.stringify({ stations: guide, terms: opts.terms, providerPubkey: opts.providerPubkey });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    void metered(req, res);
  });

  return { server, service };
}

export { StationRewind };
