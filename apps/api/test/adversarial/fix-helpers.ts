/**
 * Helpers for the second-pass ("fix-*") adversarial suites (not a test file itself).
 */
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';
import type pg from 'pg';
import { sha256Hex } from '../../src/files/hash.js';

interface Blobs {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
}

export interface Rewrite {
  schemaVer?: number;
  meta?: (m: any) => any;
  facts?: (line: any[]) => any[];
}

/**
 * Rewrite a stored snapshot's files and keep it consistent: new checksums and sizes in both the
 * stored manifest.json and the database copy of the manifest (as only someone with database and
 * storage access could do).
 */
export async function rewriteSnapshot(blobs: Blobs, su: pg.Client, snapshotId: string, r: Rewrite): Promise<void> {
  const row = (await su.query<{ storage_prefix: string; manifest: any }>('select storage_prefix, manifest from epm.snapshot where snapshot_id = $1', [snapshotId])).rows[0]!;
  const files: any[] = [];
  for (const f of row.manifest.files) {
    const key = `${row.storage_prefix}/${f.name}`;
    let bytes = (await blobs.get(key))!;
    if (f.name === 'metadata.json.gz' && r.meta) {
      bytes = gzipSync(strToU8(JSON.stringify(r.meta(JSON.parse(strFromU8(gunzipSync(bytes)))))));
    } else if (f.name.startsWith('facts-') && r.facts) {
      const text = strFromU8(gunzipSync(bytes));
      const lines = text ? text.split('\n').map((l) => JSON.stringify(r.facts!(JSON.parse(l)))) : [];
      bytes = gzipSync(strToU8(lines.join('\n')));
    }
    await blobs.put(key, bytes, 'application/gzip');
    files.push({ ...f, bytes: bytes.byteLength, sha256: await sha256Hex(bytes) });
  }
  const manifest = { ...row.manifest, files, schema_ver: r.schemaVer ?? row.manifest.schema_ver };
  await blobs.put(`${row.storage_prefix}/manifest.json`, strToU8(JSON.stringify(manifest, null, 2)), 'application/json');
  await su.query('update epm.snapshot set manifest = $2, schema_ver = $3 where snapshot_id = $1', [snapshotId, JSON.stringify(manifest), manifest.schema_ver]);
}

/** A format 2 snapshot as format 1 wrote it: values as JSON numbers, no deployed_* fields or tree_ordinal. */
export const TO_FORMAT_1: Rewrite = {
  schemaVer: 1,
  meta: (m) => ({ ...m, members: m.members.map(({ tree_ordinal: _t, deployed_parent_id: _p, deployed_agg_op: _a, ...rest }: any) => rest) }),
  facts: (l) => [...l.slice(0, 16), Number(l[16])],
};

/** Read a snapshot's metadata file. */
export async function snapshotMeta(blobs: Blobs, su: pg.Client, snapshotId: string): Promise<any> {
  const row = (await su.query<{ storage_prefix: string }>('select storage_prefix from epm.snapshot where snapshot_id = $1', [snapshotId])).rows[0]!;
  return JSON.parse(strFromU8(gunzipSync((await blobs.get(`${row.storage_prefix}/metadata.json.gz`))!)));
}
