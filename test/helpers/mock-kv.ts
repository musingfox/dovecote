export class MockKV {
  private store = new Map<string, { value: string; expiresAt?: number }>();

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
    options?: { expirationTtl?: number }
  ): Promise<void> {
    const expiresAt = options?.expirationTtl
      ? Date.now() + options.expirationTtl * 1000
      : undefined;
    this.store.set(key, { value, expiresAt });
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

  async getWithMetadata() {
    return { value: null, metadata: null };
  }
}
