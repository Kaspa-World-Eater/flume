/**
 * `flume` -- broadcast a stream, or tune in and pay per second on the kaspa-x402 rail.
 *
 *   flume serve <dir> [--price N] [--port N] [--babel N]     broadcast every file under <dir> as a station
 *   flume guide <url>                                         see what's on the air
 *   flume channel open <url> [--escrow KAS]                   listener: open a payment channel
 *   flume channels                                            listener: your open channels
 *   flume tune <url> <station> [--out FILE] [--pay] [--seconds N]   listen; --pay bills the channel
 *   flume refund <covenantId>                                listener: reclaim a channel after its timeout
 *   flume claim <covenantId>                                 broadcaster: claim what a channel's vouchers cover
 *   flume address [--role listener|broadcaster]
 *
 * The money is a kaspa-x402 escrow channel, exactly as in spigot: open once, listen to as much as
 * you like against it, refund the rest. metered meters each second by two-sided count; the rail pays.
 */
import { statSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, resolve, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileSessionStore } from 'metered-protocol';
import type { Network } from 'metered-protocol/rail';
import { onDemand, type Station } from '../src/station.js';
import { broadcast, GUIDE_PATH } from '../src/broadcaster.js';
import { tune, readGuide } from '../src/listener.js';
import { streamTerms, kas } from '../src/terms.js';
import { identity } from '../src/keys.js';
import * as chan from '../src/channel.js';

const argv = process.argv.slice(2);
const [command, ...rest] = argv;
const flag = (name: string, fallback: string): string => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1] ?? fallback;
};
const num = (name: string, fallback: number): number => Number(flag(name, String(fallback)));
const positional = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] ?? '').startsWith('--'));
const NETWORK = flag('network', 'kaspa:testnet-10');
const bare = () => NETWORK.replace(/^kaspa:/, '') as Network;
const network = (g: { terms: { network: string } }): Network => g.terms.network.replace(/^kaspa:/, '') as Network;
const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

function usage(): never {
  console.log([
    '',
    '  flume -- pay-per-second streaming, metered by both sides, settled on kaspa-x402',
    '',
    '    flume serve <dir> [--price N] [--port N] [--babel N] [--window DAA]',
    '    flume guide <url>',
    '    flume channel open <url> [--escrow KAS]        listener: open a payment channel',
    '    flume channels                                 listener: your open channels',
    '    flume tune <url> <station> [--out F] [--pay] [--seconds N]   listen; --pay bills the channel',
    '    flume refund <covenantId>                      listener: reclaim a channel after its timeout',
    '    flume claim <covenantId>                       broadcaster: claim what the vouchers cover',
    '    flume address [--role listener|broadcaster]',
    '',
  ].join('\n'));
  process.exit(1);
}

/** Every non-empty file under <dir> becomes an on-demand station named by its path. */
function stationsFrom(root: string): Station[] {
  const one = (name: string): Station => onDemand(name, new Uint8Array(readFileSync(join(root, name))));
  const names = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && statSync(join(root, e.name)).size > 0)
    .map((e) => e.name);
  return names.map(one);
}

async function serve(): Promise<void> {
  const dir = positional[0];
  if (!dir) usage();
  const root = resolve(dir);
  if (!statSync(root).isDirectory()) throw new Error(`${root} is not a directory`);
  const stations = stationsFrom(root);
  if (stations.length === 0) throw new Error(`${root} holds no non-empty files to broadcast`);

  const price = num('price', 1);
  const me = identity('broadcaster');
  const terms = streamTerms({
    network: NETWORK, sompiPerByte: price, babelBytes: num('babel', 16 * 1024),
    sessionBytes: num('session', 64 * 1024 * 1024), responseWindowDaa: num('window', 600),
  });

  let channelFor: Parameters<typeof broadcast>[0]['channelFor'];
  try {
    const { rpc } = await chan.connect(bare());
    await rpc.disconnect().catch(() => undefined);
    channelFor = chan.sellerChannels(me.publicKeyHex, bare(), num('babel', 16 * 1024));
    console.log('  channel verification on (a node is reachable)');
  } catch {
    console.log('  channel verification off (no node reachable) -- sessions run unpaid');
  }

  const { server } = broadcast({
    stations, terms, providerSk: me.secretKeyHex, providerPubkey: me.publicKeyHex,
    ...(channelFor ? { channelFor } : {}), sessions: fileSessionStore(`${me.file}.sessions.jsonl`),
  });
  await new Promise<void>((r) => server.listen(num('port', 8402), '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;

  console.log(`\n  flume on the air: ${stations.length} station(s) from ${root}`);
  console.log(`  broadcaster ${me.publicKeyHex.slice(0, 16)}...  (${me.file})`);
  console.log(`  ${price} sompi/byte, ${terms.babelUnits} bytes per babel\n`);
  for (const s of stations) console.log(`    ${s.name}   (${s.available()} bytes on demand)`);
  console.log(`\n  http://127.0.0.1:${port}${GUIDE_PATH}\n`);
}

async function guide(): Promise<void> {
  const base = positional[0];
  if (!base) usage();
  const g = await readGuide(base);
  console.log(`\n  broadcaster ${g.providerPubkey.slice(0, 16)}...  ${g.stations.length} station(s), ${g.terms.unitPriceSompi} sompi/byte, ${g.terms.network}\n`);
  for (const s of g.stations) console.log(`    ${pad(s.name, 40)} ${pad(s.kind, 11)} ${s.available} bytes`);
  console.log('');
}

async function channel(): Promise<void> {
  if (positional[0] !== 'open') usage();
  const base = positional[1];
  if (!base) usage();
  const g = await readGuide(base);
  const escrow = BigInt(Math.round(Number(flag('escrow', '1')) * 1e8));
  const me = identity('listener');
  console.log(`\n  opening a ${kas(Number(escrow))} KAS channel with broadcaster ${g.providerPubkey.slice(0, 16)}...`);
  const { channel: c, txid } = await chan.open(me.secretKeyHex, g.providerPubkey, network(g), escrow, BigInt(g.terms.responseWindowDaa));
  console.log(`  genesis    ${txid}\n  covenantId ${c.covenantId}\n  now: flume tune ${base} <station> --pay\n`);
}

async function channels(): Promise<void> {
  const rows = chan.channels();
  if (rows.length === 0) { console.log('\n  no channels. Open one: flume channel open <url>\n'); return; }
  console.log('');
  for (const r of rows) {
    console.log(`    ${r.channel.covenantId}`);
    console.log(`      broadcaster ${r.sellerPubkey.slice(0, 16)}...  ${kas(Number(r.channel.active.amount))} KAS left  settled ${r.channel.settledTotal}  refund@DAA ${r.channel.timeoutDaa}`);
  }
  console.log('');
}

async function tuneIn(): Promise<void> {
  const [base, station] = positional;
  if (!base || !station) usage();
  const g = await readGuide(base);
  const out = resolve(flag('out', `${basename(station)}.stream`));
  const paying = argv.includes('--pay');
  const seconds = num('seconds', 0);
  const me = identity('listener');

  const held = paying ? chan.channelWith(g.providerPubkey) : null;
  if (paying && !held) throw new Error(`no open channel with this broadcaster; run: flume channel open ${base}`);
  const proposal = held ? chan.propose(held) : undefined;

  if (existsSync(out)) writeFileSync(out, new Uint8Array(0));
  console.log(`\n  tuning in to ${station}  ->  ${out}`);
  if (proposal) console.log(`  billed to channel ${proposal.covenantId.slice(0, 16)}...`);
  if (seconds > 0) console.log(`  stopping after ${seconds}s`);
  else console.log('  Ctrl+C to stop and pay for exactly what played');

  let stopped = false;
  process.on('SIGINT', () => { stopped = true; });

  const { receipt } = await tune({
    base, listenerSk: me.secretKeyHex, station, expectedNetwork: g.terms.network,
    ...(proposal ? { channel: proposal } : {}),
    ...(seconds > 0 ? { playMs: seconds * 1000 } : {}),
    onBytes: (c) => appendFileSync(out, c),
    stop: () => stopped,
  });

  console.log(`\n  ${receipt.until}: ${receipt.chunks} chunk(s), ${receipt.bytesPlayed} bytes played`);
  console.log(`  owed ${receipt.sompiSpent} sompi (${kas(receipt.sompiSpent)} KAS)`);
  console.log(proposal
    ? '\n  vouched to the channel as it played. The broadcaster claims when it likes.\n'
    : '\n  not billed on chain. Open a channel and use --pay to settle.\n');
  process.exit(0);
}

async function refund(): Promise<void> {
  const covenantId = positional[0];
  if (!covenantId) usage();
  const me = identity('listener');
  console.log(`\n  refunding channel ${covenantId.slice(0, 16)}... once its timeout passes (this waits)`);
  const out = await chan.refund(me.secretKeyHex, covenantId);
  console.log(`  ${out.txid}\n  ${kas(Number(out.refunded))} KAS back to the listener\n`);
}

async function claim(): Promise<void> {
  const covenantId = positional[0];
  if (!covenantId) usage();
  const me = identity('broadcaster');
  const voucher = chan.voucherFor(`${me.file}.sessions.jsonl`, covenantId);
  if (!voucher) throw new Error(`no voucher for ${covenantId} in this broadcaster's sessions -- has anyone paid on it?`);
  const record = chan.recall(covenantId);
  const claimable = BigInt(voucher.amount) - record.channel.settledTotal;
  if (claimable <= 0n) { console.log(`\n  nothing to claim: settled ${record.channel.settledTotal} already covers voucher ${voucher.amount}\n`); return; }
  console.log(`\n  claiming ${kas(Number(claimable))} KAS on channel ${covenantId.slice(0, 16)}... (voucher ceiling ${voucher.amount})`);
  const out = await chan.claim(me.secretKeyHex, covenantId, voucher, claimable);
  console.log(`  ${out.txid}\n  ${kas(Number(out.paid))} KAS to the broadcaster. Escrow continues, settled ${out.channel.settledTotal}.\n`);
}

async function address(): Promise<void> {
  const me = identity(flag('role', 'listener') === 'broadcaster' ? 'broadcaster' : 'listener');
  const { sdk, rpc } = await chan.connect(bare());
  const addr = new sdk.PrivateKey(me.secretKeyHex).toKeypair().toAddress(new sdk.NetworkId(bare())).toString();
  const { entries } = await rpc.getUtxosByAddresses([addr]);
  const total = entries.reduce((a: bigint, e: { amount: bigint }) => a + BigInt(e.amount), 0n);
  console.log(`\n  ${addr}\n  ${kas(Number(total))} KAS in ${entries.length} utxo(s)\n  key: ${me.file}\n`);
  await rpc.disconnect().catch(() => undefined);
  process.exit(0);
}

const COMMANDS: Record<string, () => Promise<void>> = { serve, guide, channel, channels, tune: tuneIn, refund, claim, address };
const run = COMMANDS[command ?? ''];
if (!run) usage();
run().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
