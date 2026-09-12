# flume

**Pay-per-second streaming. You pay for the audio and video that actually plays — and the instant
you stop, so does the meter.**

No subscription, no plan, no cancellation. Tune in, and each second of stream is measured by both
sides and paid for as it arrives. Close the tab and you have paid for exactly what you heard, to the
byte. Built on [metered](https://github.com/kaspahttp402/metered-protocol) and settled on Kaspa.

```bash
# broadcaster
flume serve ./music --price 1

# listener
flume guide http://station:8402
flume tune http://station:8402 song --out ./song.opus
```

It is [spigot](https://github.com/kaspahttp402/spigot) with one change: the source is **open-ended**
instead of a fixed file. A recording, a live radio feed, a video — all of them are just bytes
arriving over time, which is what metered already meters.

---

## What makes this different

**Stop and the meter stops — mid-song, to the byte.** A listener leaves at any moment and pays for
what played and nothing after. No product built on subscriptions or up-front purchase can offer
that, because their unit is the whole thing.

**The broadcaster cannot overstate what it sent.** The unit is `net.bytes_delivered.v1`, metered by
`octets`, which is exact: both sides count the same bytes, tolerance zero. A dishonest count is
caught by the listener's own count, and the stream halts.

**A stall costs nothing.** The listener drives its own position, so a dropped connection is just a
reconnect from where it left off — no renegotiation, no double charge, no gap it paid for.

**Live is genuinely live.** A live station is a byte buffer that grows as sound is produced. When a
listener catches up to the edge, it waits a beat and asks again — and is billed for none of the
empty moments, because metered bills only for bytes that arrive.

## The two kinds of station

| | On-demand | Live |
|---|---|---|
| **is** | a recording — a fixed buffer | a feed still being produced |
| **length** | known up front | grows; unknown until it closes |
| **end** | the last byte | only when the broadcaster closes it |
| **rewind** | any offset, always | only within a bounded window; older bytes are gone |
| **whole-content check** | possible | impossible — you verify each chunk, not the future |

Everything else is identical, because a chunk of a stream and a chunk of a file are the same thing:
a range of bytes both sides can count.

## How a listen works

1. The listener reads the **guide** — what's on the air, live or recorded, and the price. Unpaid.
2. It opens a metered session and pulls the stream one **babel** at a time — 16 KB by default,
   roughly a third of a second of audio, so the payment cadence never starves the buffer.
3. Each babel: the broadcaster returns the next bytes and its count; the listener counts the same
   bytes and signs its own figure; on the rail, a payment voucher travels with that signature.
4. Repeat from the listener's own offset until it stops, the recording ends, or the funds run out.
   **Whichever comes first, it paid for exactly what it received.**

## What is here

| | |
|---|---|
| `src/station.ts` | a byte source you pull from an offset — `onDemand` (a recording) and `LiveStation` (a growing feed) |
| `src/broadcaster.ts` | the `Deliver` that serves the next bytes, and the HTTP server + guide |
| `src/listener.ts` | `tune` — pull, play, pay, and stop at any moment |
| `src/terms.ts` | the Offer terms, priced per byte; babel size as the payment cadence |
| `src/ask.ts` | the request grammar — a station and an offset, validated not trusted |

```bash
npm install
npm test
```

## Status

The streaming layer runs end to end in-process: a whole recording plays byte-for-byte; a live feed
delivers as it grows; and **stopping mid-stream pays only for what played** — the headline property,
pinned by a test. Payment runs through metered's session; every babel is countersigned.

On-chain settlement uses metered's kaspa-x402 channel — the same rail
[spigot](https://github.com/kaspahttp402/spigot) settles on. Wiring the channel commands into the
CLI is the next step; the metering and the stop-to-the-byte behaviour are done.

## Licence

MIT.
