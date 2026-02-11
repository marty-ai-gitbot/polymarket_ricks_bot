export type GammaMarket = {
  id: string;
  slug: string;
  question: string;
  active: boolean;
  volumeNum?: number;
  liquidityNum?: number;
  updatedAt?: string;
  // outcome token ids are what CLOB uses
  tokens: Array<{ token_id: string; outcome: string }>;
};

export class GammaClient {
  constructor(private readonly baseUrl: string = "https://gamma-api.polymarket.com") {}

  async listMarkets(limit = 100): Promise<GammaMarket[]> {
    const url = new URL("/markets", this.baseUrl);
    url.searchParams.set("limit", String(limit));

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gamma listMarkets failed: ${res.status}`);
    const json = (await res.json()) as any[];

    return json.map(m => ({
      id: String(m.id),
      slug: String(m.slug ?? ""),
      question: String(m.question ?? m.title ?? ""),
      active: Boolean(m.active ?? m.isActive ?? true),
      volumeNum: m.volumeNum != null ? Number(m.volumeNum) : m.volume != null ? Number(m.volume) : undefined,
      liquidityNum:
        m.liquidityNum != null
          ? Number(m.liquidityNum)
          : m.liquidity != null
            ? Number(m.liquidity)
            : m.liquidityUsd != null
              ? Number(m.liquidityUsd)
              : m.liquidity_usd != null
                ? Number(m.liquidity_usd)
                : undefined,
      updatedAt: m.updatedAt ?? m.updated_at ?? m.lastUpdated ?? m.updated ?? undefined,
      tokens: Array.isArray(m.tokens)
        ? m.tokens.map((t: any) => ({ token_id: String(t.token_id ?? t.tokenId ?? t.id), outcome: String(t.outcome ?? t.name ?? "") }))
        : []
    }));
  }
}
