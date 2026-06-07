import { readRepoEvents } from "./observability.js";
import type { TokenOptConfig } from "./types.js";

export function buildReport(config: TokenOptConfig, repoRoot: string): string {
  const events = readRepoEvents(config, repoRoot);
  if (events.length === 0) {
    return "TokenOpt report\n\nNo events recorded for this repository yet.";
  }

  const byAction = new Map<string, number>();
  let tokensSaved = 0;
  for (const event of events) {
    byAction.set(event.action, (byAction.get(event.action) ?? 0) + 1);
    tokensSaved += event.estimatedTokensSaved ?? 0;
  }

  const actionLines = [...byAction.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([action, count]) => `- ${action}: ${count}`);

  const last = events.slice(-5).map((event) => `- ${event.timestamp} ${event.eventName} ${event.action}${event.reason ? `: ${event.reason}` : ""}`);
  return [
    "TokenOpt report",
    "",
    `events: ${events.length}`,
    `estimatedTokensSaved: ${tokensSaved}`,
    "",
    "Actions",
    ...actionLines,
    "",
    "Recent",
    ...last
  ].join("\n");
}
