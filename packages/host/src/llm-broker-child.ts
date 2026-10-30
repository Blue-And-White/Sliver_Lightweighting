import { bindLlmBroker, type LlmBrokerOptions } from "./llm-broker.ts";

const options: LlmBrokerOptions = {
  upstreamBaseUrl: process.env.SILVER_LLM_UPSTREAM ?? "",
  upstreamApiKey: process.env.SILVER_LLM_UPSTREAM_KEY ?? "",
  capability: process.env.SILVER_LLM_CAPABILITY ?? "",
};
if (process.env.SILVER_LLM_LISTEN_HOST) options.listenHost = process.env.SILVER_LLM_LISTEN_HOST;
if (process.env.SILVER_LLM_ADVERTISED_HOST) options.advertisedHost = process.env.SILVER_LLM_ADVERTISED_HOST;
if (process.env.SILVER_LLM_LEDGER) options.ledgerPath = process.env.SILVER_LLM_LEDGER;
if (process.env.SILVER_LLM_WIRE) options.wireDebugPath = process.env.SILVER_LLM_WIRE;
if (process.env.SILVER_LLM_PROVIDER) options.provider = process.env.SILVER_LLM_PROVIDER;
if (process.env.SILVER_LLM_MODEL) options.model = process.env.SILVER_LLM_MODEL;
if (process.env.SILVER_LLM_API) options.api = process.env.SILVER_LLM_API;
if (process.env.SILVER_LLM_MAX_TOKENS) {
  const maxTokens = Number(process.env.SILVER_LLM_MAX_TOKENS);
  if (Number.isSafeInteger(maxTokens) && maxTokens > 0) options.maxTokens = maxTokens;
}
if (process.env.SILVER_LLM_MAX_CONSECUTIVE_FAILED_TURNS) {
  const maxConsecutiveFailedTurns = Number(process.env.SILVER_LLM_MAX_CONSECUTIVE_FAILED_TURNS);
  if (Number.isSafeInteger(maxConsecutiveFailedTurns) && maxConsecutiveFailedTurns > 0) {
    options.maxConsecutiveFailedTurns = maxConsecutiveFailedTurns;
  }
}
if (process.env.SILVER_LLM_EFFORT) options.effort = process.env.SILVER_LLM_EFFORT;
const handle = await bindLlmBroker(options);
process.stdout.write(
  `silver-llm-broker ${JSON.stringify({
    port: handle.port,
    origin: handle.origin,
    listenHost: handle.listenHost,
    advertisedHost: handle.advertisedHost,
  })}\n`,
);
const stop = () => {
  void handle.close().finally(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
