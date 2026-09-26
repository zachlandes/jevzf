import { JEV_PRICE, systemOneProvider } from "./typesafe.mjs";

// Experimental: the gateway serves Jev only under a floating id, so its version cannot be pinned
export const GATEWAY_MODEL = "typesafe-ai/jev";

export const vercelAiGateway = systemOneProvider({
  name: "vercel-ai-gateway",
  label: "Vercel AI Gateway",
  keyEnv: "AI_GATEWAY_API_KEY",
  // The gateway's TypeSafe-compatible endpoint, which takes TypeSafe's request and response shapes
  endpoint: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
  wireModel: GATEWAY_MODEL,
  pinned: false,
  // The gateway charges the provider's list price with no markup
  price: { ...JEV_PRICE, model: GATEWAY_MODEL, source: "https://vercel.com/ai-gateway/models/jev", checked: "2026-09-26" },
  // The gateway publishes no limits of its own and sheds Jev requests under load, so these are
  // conservative guesses rather than measurements
  limits: { requestsPerMinute: 60, tokensPerSecond: 250000, inFlight: 2 },
  // Against a gateway that is shedding load, each retry is one more refused attempt
  maxRetries: 1,
  pauseFallbackMs: 5000
});
