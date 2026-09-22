/**
 * A proof a stranger cannot check is not a proof. Two rules, from the kaspanet/kccs#29 review and
 * from what it turned into on 2026-09-22: no truncated ids, and every cited id archived.
 *
 * Both bit here. The README cited the 2026-09-14 genesis and claim as bare 8-char prefixes, and by
 * the time anyone looked they had aged out of the public index -- which serves about six days.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { truncatedIds, citedIds } from './pinned.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = ['README.md', ...readdirSync(join(root, 'docs')).filter((f) => /\.(md|html)$/.test(f)).map((f) => join('docs', f))];

test('a prefix plus an ellipsis is caught; a whole id and ordinary prose are not', () => {
  const full = 'a'.repeat(64);
  assert.deepEqual(truncatedIds('tx `81c3008f1fe5d79508105ada...` landed'), [{ line: 1, text: '81c3008f1fe5d79508105ada...' }]);
  assert.deepEqual(truncatedIds(`tx ${full} landed`), []);
  assert.deepEqual(truncatedIds('and so on... the station 0xdeadbeef and 12345678 cost'), []);
});

test('no document or page cites a transaction by a truncated id', () => {
  const found = docs.flatMap((d) => truncatedIds(readFileSync(join(root, d), 'utf8')).map((t) => `${d}:${t.line} ${t.text}`));
  assert.deepEqual(found, [], `truncated ids in docs:\n  ${found.join('\n  ')}`);
});

/*
 * Cited => archived. The rail writes docs/proofs/<txid>.json at broadcast (metered-protocol 2.0.1
 * and up), so for flume this holds by construction -- which is exactly why it is worth asserting:
 * it fails the moment a proof is cited from somewhere the archive did not see.
 */
test('every cited transaction id has an archived proof in docs/proofs', () => {
  const missing = docs.flatMap((d) => citedIds(readFileSync(join(root, d), 'utf8'))
    .filter((id) => !existsSync(join(root, 'docs', 'proofs', `${id}.json`)))
    .map((id) => `${d}: ${id}`));
  assert.deepEqual(missing, [], `cited but not archived:\n  ${missing.join('\n  ')}`);
});
