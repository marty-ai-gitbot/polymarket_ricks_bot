import { z } from "zod";

const EnvSchema = z.object({
  // Runtime
  DRY_RUN: z.coerce.boolean().default(true),
  PAPER: z.coerce.boolean().default(true),
  LIVE: z.coerce.boolean().default(false),

  LOG_LEVEL: z.string().default("info"),

  // LLM
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  MAX_LLM_USD_PER_DAY: z.coerce.number().default(2),
  MAX_LLM_USD_PER_HOUR: z.coerce.number().default(0.5),

  // Polymarket
  POLYMARKET_CLOB_BASE_URL: z.string().default("https://clob.polymarket.com"),

  // Strategy / selection
  TARGETS_MODE: z.enum(["top_volume", "easy_targets", "slugs"]).default("top_volume"),
  TARGET_SLUGS: z.string().optional(),
  MAX_MARKETS_TO_ANALYZE: z.coerce.number().default(20),

  // Risk
  BANKROLL_USD: z.coerce.number().default(100),
  MAX_RISK_PER_MARKET_USD: z.coerce.number().default(5),
  FRACTIONAL_KELLY: z.coerce.number().default(0.25)
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error(parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment");
  }
  return parsed.data;
}
