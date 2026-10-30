export const DISABLED_PLATFORM_HINT_REASON =
  "Platform hints are disabled for this Mission; do not request the hint endpoint through another tool.";

export function refuseDisabledPlatformHint(
  tool: string,
  args: Record<string, unknown>,
  hintPolicy: string | undefined,
): string | undefined {
  if (hintPolicy !== "off") return undefined;
  if (tool === "request_hint") return DISABLED_PLATFORM_HINT_REASON;
  const request = tool === "bash" ? args.command : args.url;
  if (
    typeof request === "string" &&
    /\/openapi\/v1\/challenges\/hint(?=$|[\s?&#/"'`])/i.test(request)
  ) return DISABLED_PLATFORM_HINT_REASON;
  return undefined;
}
