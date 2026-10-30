import { ProcessDocker } from "@silver/isolation";

/** Docker IsolationHost is opt-in. Default --live is the host filesystem sandbox. */
export function requireLiveIsolation(isolate: boolean, dockerOk: boolean): void {
  if (isolate && !dockerOk) {
    throw new Error(
      "silver run --live --isolate requires IsolationHost (docker). Default --live uses the host filesystem sandbox.",
    );
  }
}

export function dockerAvailable(): boolean {
  try {
    new ProcessDocker().run(["docker", "info"], { timeout: 5 });
    return true;
  } catch {
    return false;
  }
}
