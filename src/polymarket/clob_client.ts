export type MarketSummary = {
  conditionId: string;
  slug?: string;
  title?: string;
  volume?: number;
  active?: boolean;
};

export type OrderBook = {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
};

export class PolymarketClobClient {
  constructor(private readonly baseUrl: string) {}

  async listMarkets(): Promise<MarketSummary[]> {
    // NOTE: Endpoint may differ; keeping minimal until you confirm preferred API shapes.
    // We'll iterate after wiring real endpoints.
    const url = new URL("/markets", this.baseUrl);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CLOB listMarkets failed: ${res.status}`);
    const json = (await res.json()) as any;
    // Best-effort normalization
    const arr: any[] = Array.isArray(json) ? json : json?.markets ?? [];
    return arr.map(m => ({
      conditionId: String(m.conditionId ?? m.condition_id ?? m.id),
      slug: m.slug,
      title: m.title,
      volume: typeof m.volume === "number" ? m.volume : Number(m.volume ?? 0),
      active: m.active ?? m.isActive
    }));
  }

  async getOrderBook(conditionId: string): Promise<OrderBook> {
    const url = new URL(`/book?condition_id=${encodeURIComponent(conditionId)}`, this.baseUrl);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CLOB getOrderBook failed: ${res.status}`);
    const json = (await res.json()) as any;
    return {
      bids: (json.bids ?? []).map((b: any) => ({ price: Number(b.price), size: Number(b.size) })),
      asks: (json.asks ?? []).map((a: any) => ({ price: Number(a.price), size: Number(a.size) }))
    };
  }
}
