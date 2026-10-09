import { UsageTokenTotals } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

export const CopilotScanState = Schema.Struct({
  sessionId: Schema.String,
  snapshots: Schema.Record(Schema.String, UsageTokenTotals),
});
export type CopilotScanState = {
  -readonly [Key in keyof typeof CopilotScanState.Type]: (typeof CopilotScanState.Type)[Key];
};

export function initialCopilotScanState(sessionId: string): CopilotScanState {
  return { sessionId, snapshots: {} };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Shutdown model metrics are cumulative across resumes; context and credit events are not tokens. */
export function parseCopilotRecord(
  value: unknown,
  state: CopilotScanState,
): readonly UsageRecord[] {
  const event = object(value);
  const data = object(event?.data);
  if (event?.type === "session.start") {
    if (typeof data?.sessionId === "string" && data.sessionId.trim()) {
      if (state.sessionId !== data.sessionId) state.snapshots = {};
      state.sessionId = data.sessionId;
    }
    return [];
  }
  if (event?.type !== "session.shutdown" || typeof event.timestamp !== "string") return [];
  const timestampMs = Date.parse(event.timestamp);
  const metrics = object(data?.modelMetrics);
  if (!Number.isFinite(timestampMs) || !metrics || !state.sessionId) return [];
  const records: UsageRecord[] = [];
  for (const [model, metric] of Object.entries(metrics)) {
    const usage = object(object(metric)?.usage);
    if (!model.trim() || !usage) continue;
    const input = count(usage.inputTokens);
    const output = count(usage.outputTokens);
    const cached = usage.cacheReadTokens == null ? 0 : count(usage.cacheReadTokens);
    const created = usage.cacheWriteTokens == null ? 0 : count(usage.cacheWriteTokens);
    const reasoning = usage.reasoningTokens == null ? 0 : count(usage.reasoningTokens);
    if (
      input === undefined ||
      output === undefined ||
      cached === undefined ||
      created === undefined ||
      reasoning === undefined ||
      cached > input ||
      created > input - cached ||
      reasoning > output
    )
      continue;
    const snapshot: UsageTokenTotals = {
      uncachedInputTokens: input - cached - created,
      cachedInputTokens: cached,
      cacheCreationTokens: created,
      outputTokens: output,
      reasoningTokens: reasoning,
    };
    const previous = Object.hasOwn(state.snapshots, model) ? state.snapshots[model] : undefined;
    const totals = { ...snapshot };
    const next = { ...snapshot };
    for (const key of Object.keys(snapshot) as (keyof UsageTokenTotals)[]) {
      totals[key] = Math.max(0, snapshot[key] - (previous?.[key] ?? 0));
      next[key] = Math.max(snapshot[key], previous?.[key] ?? 0);
    }
    totals.reasoningTokens = Math.min(totals.reasoningTokens, totals.outputTokens);
    state.snapshots = { ...state.snapshots, [model]: next };
    if (totalTokens(totals) === 0) continue;
    records.push({
      provider: "copilot",
      timestampMs,
      model,
      sessionId: state.sessionId,
      totals,
      // requests.cost is Copilot billing units, not USD.
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: JSON.stringify(["copilot", state.sessionId, model, next]),
    });
  }
  return records;
}

export function parseCopilotLine(line: string, state: CopilotScanState): readonly UsageRecord[] {
  try {
    return parseCopilotRecord(JSON.parse(line), state);
  } catch {
    return [];
  }
}
