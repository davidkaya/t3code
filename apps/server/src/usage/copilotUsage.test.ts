// @effect-diagnostics nodeBuiltinImport:off - exercise byte-exact native transcript resume.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { initialCopilotScanState, parseCopilotRecord } from "./copilotUsage.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import { decodeScanCache, encodeScanCache, type ScanCache } from "./usageScanCache.ts";
import { readTranscriptRecords } from "./usageTranscriptReader.ts";

// Native session.shutdown envelope verified against GitHub's gh-aw Copilot event reader.
function shutdown(inputTokens: number, outputTokens: number, day = "01", model = "gpt-5.4") {
  return {
    type: "session.shutdown",
    id: `shutdown-${day}`,
    timestamp: `2026-08-${day}T10:00:00Z`,
    data: {
      modelMetrics: {
        [model]: {
          usage: { inputTokens, outputTokens, cacheReadTokens: 10, cacheWriteTokens: 20 },
          requests: { count: 3, cost: 999 },
        },
      },
    },
  };
}

describe("Copilot shutdown usage", () => {
  it("splits inclusive input totals and never treats request credits as dollars", () => {
    const records = parseCopilotRecord(shutdown(100, 50), initialCopilotScanState("session"));
    assert.strictEqual(records.length, 1);
    assert.deepStrictEqual(records[0]?.totals, {
      uncachedInputTokens: 70,
      cachedInputTokens: 10,
      cacheCreationTokens: 20,
      outputTokens: 50,
      reasoningTokens: 0,
    });
    assert.isNull(records[0]?.reportedCostUsd);
    assert.strictEqual(records[0]?.model, "gpt-5.4");
  });

  it("counts only cumulative increases, separately for each model", () => {
    const state = initialCopilotScanState("session");
    parseCopilotRecord(shutdown(100, 50), state);
    assert.deepStrictEqual(parseCopilotRecord(shutdown(100, 50), state), []);
    assert.deepStrictEqual(parseCopilotRecord(shutdown(90, 40), state), []);
    const resumed = parseCopilotRecord(shutdown(150, 80, "02"), state);
    assert.strictEqual(resumed[0]?.totals.uncachedInputTokens, 50);
    assert.strictEqual(resumed[0]?.totals.outputTokens, 30);
    const switched = parseCopilotRecord(shutdown(100, 50, "02", "claude-opus-4.7"), state);
    assert.strictEqual(switched[0]?.totals.uncachedInputTokens, 70);
  });

  it("ignores context, credits, malformed metrics and missing timestamps without changing baselines", () => {
    const state = initialCopilotScanState("session");
    for (const event of [
      { type: "session.usage_info", data: { currentTokens: 1000 } },
      { type: "session.usage_checkpoint", data: { totalNanoAiu: 1000 } },
      { ...shutdown(100, 50), timestamp: "invalid" },
      shutdown(20, 50),
      shutdown(-1, 50),
      shutdown(100, 1.5),
      { ...shutdown(100, 50), data: { modelMetrics: { "gpt-5.4": { usage: {} } } } },
    ]) {
      assert.deepStrictEqual(parseCopilotRecord(event, state), []);
    }
    assert.deepStrictEqual(state.snapshots, {});
  });

  it("uses session metadata and deduplicates copied snapshots in aggregation", () => {
    const state = initialCopilotScanState("directory");
    parseCopilotRecord({ type: "session.start", data: { sessionId: "canonical" } }, state);
    const records = parseCopilotRecord(shutdown(100, 50), state);
    const aggregator = new UsageAggregator({
      sinceDay: "2026-08-01",
      untilDay: "2026-08-02",
      timeZone: "UTC",
      rates: new Map(),
    });
    for (const record of [...records, ...records]) aggregator.add(record);
    const { buckets } = aggregator.finish();
    assert.strictEqual(buckets.length, 1);
    assert.strictEqual(buckets[0]?.totals.outputTokens, 50);
    assert.strictEqual(buckets[0]?.sessions, 1);
    assert.strictEqual(buckets[0]?.costSource, "unpriced");
    assert.strictEqual(records[0]?.sessionId, "canonical");
  });

  it("retains an earlier snapshot as the baseline for date-bounded reports", () => {
    const state = initialCopilotScanState("session");
    const records = [
      ...parseCopilotRecord(shutdown(100, 50), state),
      ...parseCopilotRecord(shutdown(150, 80, "02"), state),
    ];
    const aggregator = new UsageAggregator({
      sinceDay: "2026-08-02",
      untilDay: "2026-08-02",
      timeZone: "UTC",
      rates: new Map(),
    });
    for (const record of records) aggregator.add(record);
    assert.strictEqual(aggregator.finish().buckets[0]?.totals.outputTokens, 30);
  });

  it("prices tokens with model rates rather than Copilot request costs", () => {
    const aggregator = new UsageAggregator({
      sinceDay: "2026-08-01",
      untilDay: "2026-08-02",
      timeZone: "UTC",
      rates: new Map([
        [
          "gpt-5.4",
          {
            inputCostPerToken: 0.01,
            outputCostPerToken: 0.02,
            cacheReadCostPerToken: 0.001,
            cacheCreationCostPerToken: 0.005,
            fast: null,
            ultrafast: null,
          },
        ],
      ]),
    });
    for (const record of parseCopilotRecord(shutdown(100, 50), initialCopilotScanState("session")))
      aggregator.add(record);
    const bucket = aggregator.finish().buckets[0];
    assert.strictEqual(bucket?.costSource, "modelPriced");
    assert.approximately(bucket?.costUsd ?? 0, 1.81, 1e-9);
  });

  it.each([0, 8 * 1024 * 1024])(
    "resumes from durable cache without counting unfinished tails twice (threshold %i)",
    async (streamingThresholdBytes) => {
      const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "copilot-usage-test-"));
      try {
        const path = NodePath.join(dir, "events.jsonl");
        const line = (input: number, output: number, day: string) =>
          JSON.stringify(shutdown(input, output, day));
        await NodeFSP.writeFile(path, line(100, 50, "01") + "\n" + line(150, 80, "02"));
        const first = await readTranscriptRecords(path, "copilot", undefined, {
          streamingThresholdBytes,
        });
        assert.isNotNull(first);
        assert.strictEqual(first.tailRecords[0]?.totals.outputTokens, 30);
        const cache: ScanCache = new Map([
          [
            path,
            {
              provider: "copilot",
              size: (await NodeFSP.stat(path)).size,
              mtimeMs: 1,
              records: first.records,
              tailRecords: first.tailRecords,
              position: first.position,
            },
          ],
        ]);
        const restored = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(cache)))).get(
          path,
        );
        assert.isDefined(restored);
        await NodeFSP.appendFile(path, "\n" + line(180, 100, "03") + "\n");
        const resumed = await readTranscriptRecords(path, "copilot", restored.position, {
          streamingThresholdBytes,
        });
        assert.isNotNull(resumed);
        assert.isTrue(resumed.resumed);
        assert.deepStrictEqual(
          resumed.records.map((record) => record.totals.outputTokens),
          [30, 20],
        );
        const full = await readTranscriptRecords(path, "copilot", undefined, {
          streamingThresholdBytes,
        });
        assert.isNotNull(full);
        assert.deepStrictEqual([...first.records, ...resumed.records], full.records);
        const corrupt = encodeScanCache(cache);
        const malformed = JSON.parse(JSON.stringify(corrupt));
        malformed.files[path].cps.snapshots["gpt-5.4"].outputTokens = -1;
        assert.strictEqual(decodeScanCache(malformed).size, 0);
      } finally {
        await NodeFSP.rm(dir, { recursive: true, force: true });
      }
    },
  );
});
