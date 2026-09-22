/**
 * What flume promises, pinned.
 *
 * metered's own suite proves the payment. These are the claims streaming adds on top:
 *   - a whole recording plays through, byte for byte;
 *   - STOPPING MID-STREAM pays for what played and nothing after -- the headline property;
 *   - a live feed delivers as it grows, and waiting at the edge costs nothing;
 *   - a listener that tuned in late cannot be charged for bytes it will never get (a rewind).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { publicKeyHex } from 'metered-protocol';
import { onDemand, LiveStation, StationRewind, type Station } from './station.js';
import { broadcast } from './broadcaster.js';
import { tune, readGuide } from './listener.js';
import { streamTerms } from './terms.js';
import { decodeAsk, encodeAsk, MalformedAsk } from './ask.js';
import { stationDeliver, NoSuchStation } from './broadcaster.js';
import { claimTooSmall, STORAGE_MASS_LIMIT } from './storage-mass.js';

const BROADCASTER_SK = 'c3'.repeat(32);
const LISTENER_SK = 'd4'.repeat(32);
const NETWORK = 'kaspa:testnet-10';
const PRICE = 1;

/** A recording of `n` bytes with a recognisable pattern, so a gap in playback would show. */
const recording = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 251);

interface Air { base: string; server: Server; stop: () => Promise<void> }

async function onAir(stations: Station[], babelBytes = 256): Promise<Air> {
  const terms = streamTerms({ network: NETWORK, sompiPerByte: PRICE, babelBytes, sessionBytes: 1_000_000 });
  const { server } = broadcast({
    stations, terms, providerSk: BROADCASTER_SK, providerPubkey: publicKeyHex(BROADCASTER_SK),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test('the guide lists what is on the air, live and on-demand alike', async () => {
  const air = await onAir([onDemand('song', recording(2000)), new LiveStation('radio')]);
  try {
    const guide = await readGuide(air.base);
    assert.deepEqual(guide.stations.map((s) => [s.name, s.kind]).sort(), [['radio', 'live'], ['song', 'on-demand']]);
    assert.equal(guide.stations.find((s) => s.name === 'song')?.available, 2000);
  } finally {
    await air.stop();
  }
});

test('A WHOLE RECORDING PLAYS THROUGH, byte for byte', async () => {
  const bytes = recording(2000);
  const air = await onAir([onDemand('song', bytes)], 256);
  try {
    const got: number[] = [];
    const { receipt } = await tune({ base: air.base, listenerSk: LISTENER_SK, station: 'song', expectedNetwork: NETWORK, onBytes: (c) => { got.push(...c); } });
    assert.deepEqual(new Uint8Array(got), bytes, 'every byte, in order');
    assert.equal(receipt.bytesPlayed, 2000);
    assert.equal(receipt.sompiSpent, 2000 * PRICE, 'paid for exactly what played');
    assert.equal(receipt.until, 'ended');
    assert.equal(receipt.chunks, Math.ceil(2000 / 256));
  } finally {
    await air.stop();
  }
});

test('STOPPING MID-STREAM pays for what played and nothing after -- the headline', async () => {
  const air = await onAir([onDemand('song', recording(10_000))], 256);
  try {
    // Stop once about a quarter of the way in. The listener leaves; the meter stops at that byte.
    let played = 0;
    const { receipt } = await tune({
      base: air.base, listenerSk: LISTENER_SK, station: 'song', expectedNetwork: NETWORK,
      onBytes: (c) => { played += c.length; },
      stop: () => played >= 2500,
    });
    assert.equal(receipt.until, 'stopped');
    assert.ok(receipt.bytesPlayed >= 2500 && receipt.bytesPlayed < 3000, `stopped promptly, at ${receipt.bytesPlayed}`);
    assert.equal(receipt.sompiSpent, receipt.bytesPlayed * PRICE, 'paid for the seconds that played, not the whole track');
    assert.ok(receipt.sompiSpent < 10_000 * PRICE, 'nowhere near the price of the whole recording');
  } finally {
    await air.stop();
  }
});

test('A LIVE FEED delivers as it grows, and waiting at the edge costs nothing', async () => {
  const radio = new LiveStation('radio');
  const air = await onAir([radio], 128);
  try {
    // Feed the station on a clock while a listener tunes in and stops after a second of "air".
    let fed = 0;
    const clock = setInterval(() => { radio.push(recording(200)); fed += 200; }, 30);
    const got: number[] = [];
    const start = Date.now();
    const { receipt } = await tune({
      base: air.base, listenerSk: LISTENER_SK, station: 'radio', expectedNetwork: NETWORK, liveGapMs: 20,
      onBytes: (c) => { got.push(...c); },
      stop: () => Date.now() - start > 700,
    });
    clearInterval(clock);
    assert.equal(receipt.until, 'stopped');
    assert.ok(receipt.bytesPlayed > 0, 'played some of the live feed');
    // The listener caught up to the edge repeatedly (empty chunks) and was billed for none of them.
    assert.equal(receipt.sompiSpent, receipt.bytesPlayed * PRICE, 'billed only for bytes that actually arrived');
    assert.ok(receipt.bytesPlayed <= fed, 'never billed ahead of what was produced');
  } finally {
    await air.stop();
  }
});

test('a live station keeps only a window: a rewind below the floor is refused, not faked', () => {
  const radio = new LiveStation('radio', 1000);
  radio.push(recording(1500)); // overflows the 1000-byte window; floor advances to 500
  assert.equal(radio.available(), 1500);
  assert.throws(() => radio.read(100, 128), StationRewind, 'below the floor');
  assert.doesNotThrow(() => radio.read(600, 128), 'inside the window is fine');
});

test('an on-demand station ends; a live one ends only when the broadcaster closes it', () => {
  const song = onDemand('song', recording(100));
  assert.equal(song.ended(100), true);
  const radio = new LiveStation('radio');
  radio.push(recording(100));
  assert.equal(radio.ended(100), false, 'caught up is not ended, for a live feed');
  radio.close();
  assert.equal(radio.ended(100), true, 'closed and caught up is ended');
});

test('the ask is validated, and an unknown station is refused', () => {
  assert.deepEqual(decodeAsk(encodeAsk({ name: 'radio', offset: 40 })), { name: 'radio', offset: 40 });
  for (const bad of ['', '{}', '{"name":"a"}', '{"name":"","offset":0}', '{"name":"a","offset":-1}']) {
    assert.throws(() => decodeAsk(bad), MalformedAsk, bad);
  }
  const deliver = stationDeliver(new Map([['song', onDemand('song', recording(100))]]));
  assert.throws(() => deliver(encodeAsk({ name: 'ghost', offset: 0 }), 128), NoSuchStation);
});

test('a broadcaster that overstates what it sent is refused, and the stream stops', async () => {
  // A dishonest broadcaster whose meter doubles the count. The listener counts the same bytes,
  // they disagree past a tolerance of zero, and tune surfaces the halt rather than swallowing it.
  const terms = streamTerms({ network: NETWORK, sompiPerByte: PRICE, babelBytes: 256, sessionBytes: 1_000_000 });
  const { server } = broadcast({
    stations: [onDemand('song', recording(2000))], terms,
    providerSk: BROADCASTER_SK, providerPubkey: publicKeyHex(BROADCASTER_SK),
    meter: (c: Uint8Array) => c.length * 2,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await assert.rejects(
      () => tune({ base, listenerSk: LISTENER_SK, station: 'song', expectedNetwork: NETWORK, onBytes: () => {} }),
      /differ by more than/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});


test('the storage-mass guard refuses a too-small channel and clears a comfortable one', () => {
  const chan = (amount: bigint) => ({ active: { amount } }) as Parameters<typeof claimTooSmall>[0];
  // The live case that the node rejected: 0.06 KAS claimed on a 0.1 KAS channel.
  const tooSmall = claimTooSmall(chan(10_000_000n), 6_000_000n, 500_000n);
  assert.ok(tooSmall && /larger channel/.test(tooSmall), 'refused with a plain instruction');
  // Comfortably above the claim (spigot cleared the same rule at this size): allowed.
  assert.equal(claimTooSmall(chan(100_000_000n), 6_000_000n, 500_000n), null, 'a large channel is fine');
  // A claim that leaves nothing behind is refused outright.
  assert.ok(claimTooSmall(chan(10_000_000n), 10_000_000n, 500_000n), 'no continuation is refused');
  assert.equal(STORAGE_MASS_LIMIT, 500_000n);
});

test('a late listener starts at the retained window floor, not a dropped offset', async () => {
  const radio = new LiveStation('radio', 500); // small window
  radio.push(recording(1200)); // window slides: floor = 700, available = 1200
  radio.close();
  const air = await onAir([radio], 128);
  try {
    const got: number[] = [];
    const { receipt } = await tune({
      base: air.base, listenerSk: LISTENER_SK, station: 'radio', expectedNetwork: NETWORK, liveGapMs: 5,
      onBytes: (c) => { got.push(...c); },
    });
    assert.equal(receipt.until, 'ended');
    assert.equal(receipt.bytesPlayed, 500, 'played exactly the retained window, no rewind error');
    assert.deepEqual(new Uint8Array(got), recording(1200).subarray(700), 'the retained bytes, from the floor');
  } finally { await air.stop(); }
});

test('a quiet live feed keeps waiting -- it is NOT treated as ended after some idle beats', async () => {
  const radio = new LiveStation('radio');
  radio.push(recording(400));
  const air = await onAir([radio], 128);
  try {
    const start = Date.now();
    const { receipt } = await tune({
      base: air.base, listenerSk: LISTENER_SK, station: 'radio', expectedNetwork: NETWORK, liveGapMs: 5,
      onBytes: () => {}, stop: () => Date.now() - start > 300, // idles well past the old 40-beat cutoff
    });
    assert.equal(receipt.until, 'stopped', 'an open but quiet station is not the end; only the caller stopping is');
    assert.equal(receipt.bytesPlayed, 400);
  } finally { await air.stop(); }
});

test('closing a live feed ends the listen at its last byte', async () => {
  const radio = new LiveStation('radio');
  radio.push(recording(400));
  radio.close();
  const air = await onAir([radio], 128);
  try {
    const { receipt } = await tune({
      base: air.base, listenerSk: LISTENER_SK, station: 'radio', expectedNetwork: NETWORK, liveGapMs: 5,
      onBytes: () => {},
    });
    assert.equal(receipt.until, 'ended', 'a closed, caught-up station is the end');
    assert.equal(receipt.bytesPlayed, 400);
  } finally { await air.stop(); }
});

test('onBytes is awaited, so an async sink applies backpressure (never two in flight)', async () => {
  const air = await onAir([onDemand('song', recording(2000))], 256);
  try {
    let inFlight = 0;
    let maxInFlight = 0;
    await tune({
      base: air.base, listenerSk: LISTENER_SK, station: 'song', expectedNetwork: NETWORK,
      onBytes: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 3));
        inFlight -= 1;
      },
    });
    assert.equal(maxInFlight, 1, 'the loop awaited each onBytes before pulling the next chunk');
  } finally { await air.stop(); }
});

/*
 * On 2026-09-22 `tune --pay` billed a channel abandoned on 09-14 -- first on disk, never refunded,
 * so still "open" -- and the broadcaster refused it. The channel to bill is the newest one.
 */
test('the channel to bill is the NEWEST open one with this broadcaster, not the first on disk', async () => {
  const { newestOpen } = await import('./channel.js');
  const rec = (covenantId: string, timeoutDaa: bigint, amount: bigint, sellerPubkey = 'aa') =>
    ({ sellerPubkey, openedAt: '', channel: { covenantId, timeoutDaa, active: { amount } } }) as unknown as Parameters<typeof newestOpen>[0][number];
  const old = rec('old', 100n, 50n);
  const newer = rec('newer', 200n, 50n);
  const spent = rec('spent', 300n, 0n);
  const other = rec('other', 400n, 50n, 'bb');
  assert.equal(newestOpen([old, spent, newer, other], 'aa')?.channel.covenantId, 'newer');
  assert.equal(newestOpen([spent], 'aa'), null);
});
