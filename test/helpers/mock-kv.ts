export class MockKV {
  private store = new Map<string, { value: string; metadata?: any; expiresAt?: number; expirationTtl?: number }>();

  async get(key: string, options?: { type?: "text" | "json" } | "text" | "json"): Promise<any> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    const type = typeof options === "string" ? options : options?.type;
    if (type === "json") return JSON.parse(entry.value);
    return entry.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: any }
  ): Promise<void> {
    const expiresAt = options?.expirationTtl
      ? Date.now() + options.expirationTtl * 1000
      : undefined;
    this.store.set(key, {
      value,
      metadata: options?.metadata,
      expiresAt,
      expirationTtl: options?.expirationTtl,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
    const all = Array.from(this.store.keys());
    const filtered = options?.prefix
      ? all.filter((k) => k.startsWith(options.prefix!))
      : all;
    const limit = options?.limit || 1000;
    const keys = filtered.slice(0, limit).map((name) => ({ name }));
    return { keys, list_complete: keys.length < limit };
  }

  async getWithMetadata(key: string): Promise<{ value: string | null; metadata: any | null }> {
    const entry = this.store.get(key);
    if (!entry) return { value: null, metadata: null };
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return { value: null, metadata: null };
    }
    return { value: entry.value, metadata: entry.metadata ?? null };
  }

  // Helper for tests that need direct store access
  getStore() {
    return this.store;
  }
}
