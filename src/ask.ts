/**
 * What a listener asks for: a station and a byte offset.
 *
 * The same shape as spigot's ask, and for the same reason. metered carries a free-form `prompt`
 * with each reservation and stays ignorant of what it means; this is the whole of what it means
 * here. The listener drives the offset, so the broadcaster keeps no per-listener position that
 * could drift -- the same ask always names the same bytes, and a reconnect is just the next ask.
 */
export class MalformedAsk extends Error {}

export interface Ask {
  name: string;
  offset: number;
}

export const encodeAsk = (ask: Ask): string => JSON.stringify(ask);

/** Parse an ask, refusing anything that is not exactly one -- it arrives from the network. */
export function decodeAsk(prompt: string): Ask {
  let parsed: unknown;
  try {
    parsed = JSON.parse(prompt);
  } catch {
    throw new MalformedAsk('the ask is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new MalformedAsk('the ask is not an object');
  const { name, offset } = parsed as Record<string, unknown>;
  if (typeof name !== 'string' || name.length === 0) throw new MalformedAsk('the ask names no station');
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
    throw new MalformedAsk('the ask has no whole, non-negative offset');
  }
  return { name, offset };
}
