/** Where file bytes live: R2 on Workers, memory or disk in Node (tests, scripts). */
export interface BlobStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(keys: string[]): Promise<void>;
  /** Every key that starts with prefix. */
  list(prefix: string): Promise<string[]>;
}

export function memoryBlobStore(): BlobStore & { keys(): string[] } {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(key, data) {
      blobs.set(key, data.slice());
    },
    async get(key) {
      return blobs.get(key)?.slice() ?? null;
    },
    async delete(keys) {
      for (const k of keys) blobs.delete(k);
    },
    async list(prefix) {
      return [...blobs.keys()].filter((k) => k.startsWith(prefix));
    },
    keys: () => [...blobs.keys()],
  };
}

/** The subset of the R2 bucket binding we use. */
export interface R2BucketLike {
  put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}

export function r2BlobStore(bucket: R2BucketLike): BlobStore {
  return {
    async put(key, data, contentType) {
      await bucket.put(key, data, { httpMetadata: { contentType } });
    },
    async get(key) {
      const obj = await bucket.get(key);
      return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    },
    async delete(keys) {
      // R2 deletes up to 1,000 keys per call.
      for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
    },
    async list(prefix) {
      const out: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, cursor });
        out.push(...page.objects.map((o) => o.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
  };
}
