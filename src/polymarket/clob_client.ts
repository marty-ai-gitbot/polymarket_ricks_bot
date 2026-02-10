export type OrderBook = {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
};

export class PolymarketClobClient {
  constructor(private readonly baseUrl: string) {}

  async getOrderBook(tokenId: string): Promise<OrderBook> {
    // Docs: GET /book?token_id=...
    const url = new URL(`/book`, this.baseUrl);
    url.searchParams.set("token_id", tokenId);

    const res = await fetch(url);
    if (!res.ok) throw new Error(`CLOB getOrderBook failed: ${res.status}`);
    const json = (await res.json()) as any;
    return {
      bids: (json.bids ?? []).map((b: any) => ({ price: Number(b.price), size: Number(b.size) })),
      asks: (json.asks ?? []).map((a: any) => ({ price: Number(a.price), size: Number(a.size) }))
    };
  }

  async getMidpoint(tokenId: string): Promise<number | null> {
    const url = new URL(`/midpoint`, this.baseUrl);
    url.searchParams.set("token_id", tokenId);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CLOB getMidpoint failed: ${res.status}`);
    const json = (await res.json()) as any;
    const mid = Number(json?.mid ?? json?.midpoint ?? json);
    return Number.isFinite(mid) ? mid : null;
  }
}
