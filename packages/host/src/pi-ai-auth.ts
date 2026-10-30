import os from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import AuthorizationService, { type AuthorizationInteraction } from "@deepseek-ai/dsh-authorization";
import LocalCredentialProvider from "@deepseek-ai/dsh-credentials-local";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import * as PiAiPlugin from "@deepseek-ai/dsh-llm-pi-ai";

export interface PiAiAuthorizationStatus {
  provider: string;
  key: string;
  label: string;
  methods: readonly { id: string; label: string }[];
  configured: boolean;
  credentialKind?: "api-key" | "grant";
  dshHome: string;
}

export function resolvePiAiCredentialHome(
  env: NodeJS.ProcessEnv = process.env,
  userHome = os.homedir(),
): string {
  const configured = env.SILVER_DSH_CREDENTIAL_HOME?.trim() || env.DSH_HOME?.trim();
  return path.resolve(configured || path.join(userHome, ".dsh"));
}

export async function inspectPiAiAuthorization(
  provider: string,
  dshHome = resolvePiAiCredentialHome(),
): Promise<PiAiAuthorizationStatus> {
  return withPiAiAuthorization(dshHome, async (ctx) => authorizationStatus(ctx, provider, dshHome));
}

export async function authorizePiAiProvider(input: {
  provider: string;
  interaction: AuthorizationInteraction;
  dshHome?: string;
  signal?: AbortSignal;
}): Promise<PiAiAuthorizationStatus> {
  const dshHome = path.resolve(input.dshHome ?? resolvePiAiCredentialHome());
  return withPiAiAuthorization(dshHome, async (ctx) => {
    const before = await authorizationStatus(ctx, input.provider, dshHome);
    if (!before.methods.some((method) => method.id === "oauth")) {
      throw new Error(`official pi-ai provider ${input.provider} has no OAuth login flow`);
    }
    const outcome = await ctx.authorization.begin({
      key: PiAiPlugin.recordKeyFor(input.provider),
      method: "oauth",
      interaction: input.interaction,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (outcome.status !== "authorized") throw new Error(`${input.provider} authorization was cancelled`);
    return authorizationStatus(ctx, input.provider, dshHome);
  });
}

async function withPiAiAuthorization<T>(dshHome: string, run: (ctx: Context) => Promise<T>): Promise<T> {
  const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(LocalCredentialProvider, { dshHome: path.resolve(dshHome), watch: false });
    await ctx.plugin(AuthorizationService);
    await ctx.plugin(PiAiPlugin, { providers: {} });
    return await run(ctx);
  } finally {
    await ctx.fiber.dispose();
  }
}

async function authorizationStatus(ctx: Context, provider: string, dshHome: string): Promise<PiAiAuthorizationStatus> {
  const key = PiAiPlugin.recordKeyFor(provider);
  const flow = ctx.authorization.describe(key);
  if (!flow) throw new Error(`official dsh-llm-pi-ai has no authorization flow for provider ${provider}`);
  const record = await ctx.credentials.describeRecord(key);
  return {
    provider,
    key,
    label: flow.label,
    methods: flow.methods.map(({ id, label }) => ({ id, label })),
    configured: record.configured,
    ...(record.kind ? { credentialKind: record.kind } : {}),
    dshHome: path.resolve(dshHome),
  };
}
