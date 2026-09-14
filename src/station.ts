/**
 * A station is a byte source you can pull from an offset, that may still be growing.
 *
 * THIS IS THE ONE THING STREAMING ADDS TO A FILE. A file has a fixed length known in advance; a
 * live stream does not -- its bytes come into being over time, and a listener that has caught up
 * waits for more rather than reaching an end. So a station answers two questions a file never has
 * to: how many bytes exist *right now*, and are more still coming.
 *
 * Everything else -- the metering, the digest of each chunk, the payment -- is identical to a
 * file, because a chunk of a stream and a chunk of a file are the same thing: a range of bytes
 * both sides can count. That is why this rides on the same protocol as pay-per-byte downloads.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Station {
  /** The catalogue name a listener tunes to. */
  name: string;
  /** A short description, and whether it is a fixed recording or an open-ended live feed. */
  kind: 'on-demand' | 'live';
  /** Bytes available from `offset`, capped at `max`. Empty when nothing new is ready yet. */
  read(offset: number, max: number): Uint8Array;
  /** How many bytes exist right now. Fixed for on-demand; grows for live. */
  available(): number;
  /** True once no more bytes will ever come (an on-demand track played to its end). */
  ended(offset: number): boolean;
  /** Lowest offset still retained: 0 for a recording; rises for a live feed as its window slides. */
  floor(): number;
  /** True once the source will produce no more bytes ever (recording, or a live feed closed). */
  closed(): boolean;
}

/** A recording: a fixed buffer, offset-addressable. On-demand streaming is just this. */
export function onDemand(name: string, bytes: Uint8Array): Station {
  return {
    name,
    kind: 'on-demand',
    read: (offset, max) => bytes.subarray(offset, Math.min(bytes.length, offset + max)),
    available: () => bytes.length,
    ended: (offset) => offset >= bytes.length,
    floor: () => 0,
    closed: () => true, // a recording's bytes all exist already; a live listener ends via its length
  };
}

/**
 * A live feed: a buffer that grows as bytes are produced.
 *
 * `push` is how a broadcaster feeds it -- a decoder, a microphone, a capture card, or (in a test
 * or a demo) a generator emitting bytes on a clock. A live station never `ended`s on its own; the
 * broadcaster ends it explicitly with `close`, which is what lets a listener that has caught up
 * know the difference between "nothing yet" and "nothing ever again".
 *
 * IT KEEPS ONLY A WINDOW. A live broadcast that ran for hours cannot hold every byte in memory,
 * and a listener cannot rewind to before it tuned in anyway. So bytes before `floor` are dropped,
 * and a listener asking below the floor is told plainly rather than served a silent gap.
 */
export class LiveStation implements Station {
  readonly kind = 'live';
  private buffer: number[] = [];
  private windowFloor = 0;
  private shut = false;

  constructor(readonly name: string, private readonly windowBytes = 4 * 1024 * 1024) {}

  push(bytes: Uint8Array): void {
    if (this.shut) throw new Error(`station ${this.name} is closed`);
    for (const b of bytes) this.buffer.push(b);
    const overflow = this.buffer.length - this.windowBytes;
    if (overflow > 0) {
      this.buffer.splice(0, overflow);
      this.windowFloor += overflow;
    }
  }

  close(): void {
    this.shut = true;
  }

  read(offset: number, max: number): Uint8Array {
    if (offset < this.windowFloor) throw new StationRewind(this.name, offset, this.windowFloor);
    const start = offset - this.windowFloor;
    return Uint8Array.from(this.buffer.slice(start, start + max));
  }

  available(): number {
    return this.windowFloor + this.buffer.length;
  }

  ended(offset: number): boolean {
    return this.shut && offset >= this.available();
  }

  floor(): number {
    return this.windowFloor;
  }

  closed(): boolean {
    return this.shut;
  }
}

/** A listener asked for bytes a live station has already dropped from its window. */
export class StationRewind extends Error {
  constructor(readonly station: string, readonly asked: number, readonly floor: number) {
    super(`station ${station}: offset ${asked} is below the live window floor ${floor}`);
  }
}

/** Every non-empty file under a directory becomes an on-demand station named by its filename. */
export function stationsFrom(root: string): Station[] {
  const one = (name: string): Station => onDemand(name, new Uint8Array(readFileSync(join(root, name))));
  const names = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && statSync(join(root, e.name)).size > 0)
    .map((e) => e.name);
  return names.map(one);
}
