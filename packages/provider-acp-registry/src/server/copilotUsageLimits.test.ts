// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Native CLI fixture runs outside the Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { layerTestProviderHost } from "@t3tools/provider-testing/host";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  copilotQuotaArgs,
  copilotQuotaToLimits,
  isCopilotCli,
  make,
} from "./copilotUsageLimits.ts";
import { AcpRegistryDriver } from "./driver.ts";

const checkedAt = "2026-10-09T12:00:00.000Z";
const quota = {
  isUnlimitedEntitlement: false,
  entitlementRequests: 300,
  usedRequests: 75,
  remainingPercentage: 75,
  usageAllowedWithExhaustedQuota: true,
  overage: 0,
  overageAllowedWithExhaustedQuota: true,
  resetDate: "2026-11-01T00:00:00Z",
};
const quotaResponse = { quotaSnapshots: { premium_interactions: quota } };
const settings = Schema.decodeSync(AcpRegistrySettings);

describe("Copilot account quota mapping", () => {
  it("uses the authoritative percentage rather than token costs or request estimates", () => {
    expect(copilotQuotaToLimits(quotaResponse, checkedAt, "account")).toEqual({
      checkedAt,
      credentialFingerprint: "account",
      windows: [
        {
          id: "copilot_premium_interactions",
          kind: "monthly",
          label: "Copilot premium requests",
          usedPercent: 25,
          resetsAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    });
    expect(
      copilotQuotaToLimits(
        {
          quotaSnapshots: {
            premium_interactions: { ...quota, usedRequests: 9999, remainingPercentage: 20 },
          },
        },
        checkedAt,
        "account",
      ).windows[0]?.usedPercent,
    ).toBe(80);
  });

  it("does not fabricate exhausted windows for unlimited or absent entitlements", () => {
    for (const snapshot of [
      { ...quota, isUnlimitedEntitlement: true },
      { ...quota, entitlementRequests: -1 },
      { ...quota, entitlementRequests: 0 },
    ]) {
      const result = copilotQuotaToLimits(
        { quotaSnapshots: { chat: snapshot } },
        checkedAt,
        "account",
      );
      expect(result.windows).toEqual([]);
      expect(result.unavailable?.reason).toBe("unsupported");
      expect(result.externalUsage?.url).toBe("https://github.com/settings/billing");
    }
  });

  it("rejects missing fields and never clamps malformed percentages into real usage", () => {
    expect(copilotQuotaToLimits({}, checkedAt, "account").unavailable?.reason).toBe("probeFailed");
    for (const percentage of [-1, 101, NaN, Infinity]) {
      expect(
        copilotQuotaToLimits(
          {
            quotaSnapshots: { chat: { ...quota, remainingPercentage: percentage } },
          },
          checkedAt,
          "account",
        ).windows,
      ).toEqual([]);
    }
    const noReset = copilotQuotaToLimits(
      {
        quotaSnapshots: { chat: { ...quota, resetDate: "not a date" } },
      },
      checkedAt,
      "account",
    );
    expect(noReset.windows[0]).not.toHaveProperty("resetsAt");
  });

  it("supports all named account allowances independently", () => {
    expect(
      copilotQuotaToLimits(
        {
          quotaSnapshots: {
            chat: { ...quota, remainingPercentage: 100 },
            completions: { ...quota, remainingPercentage: 0 },
            future_allowance: quota,
          },
        },
        checkedAt,
        "account",
      ).windows.map((window) => [window.label, window.usedPercent]),
    ).toEqual([
      ["Copilot chat", 0],
      ["Copilot completions", 100],
      ["Copilot future allowance", 25],
    ]);
  });

  it("targets only Copilot CLI, not the language server or arbitrary local commands", () => {
    expect(isCopilotCli(settings({ agentId: "github-copilot-cli" }))).toBe(true);
    expect(isCopilotCli(settings({ agentId: "github-copilot" }))).toBe(false);
    expect(isCopilotCli(settings({ source: "local", commandPath: "C:\\tools\\copilot.cmd" }))).toBe(
      true,
    );
    expect(isCopilotCli(settings({ source: "local", commandPath: "/tools/other" }))).toBe(false);
  });

  it("preserves account flags but refuses commands that could start agent work", () => {
    expect(
      copilotQuotaArgs(["--acp", "--config-dir", "/home/isolated", "--auth-token-env=TEST_AUTH"]),
    ).toEqual([
      "--config-dir",
      "/home/isolated",
      "--auth-token-env=TEST_AUTH",
      "--headless",
      "--stdio",
      "--no-auto-update",
    ]);
    expect(() => copilotQuotaArgs(["--prompt", "do work"])).toThrow();
    expect(() => copilotQuotaArgs(["--config-dir"])).toThrow();
  });
});

const layerTest = layerTestProviderHost({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
);

it.layer(layerTest)("Copilot account-only RPC", (it) => {
  function runProbe(scenario: string, throughDriver = false) {
    return Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-copilot-quota-"))),
        (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
      );
      const log = NodePath.join(directory, "requests.jsonl");
      const command = writeFakeCli({
        directory,
        name: "copilot",
        source: `
          import { appendFileSync } from "node:fs";
          import { createMessageConnection, StreamMessageReader, StreamMessageWriter, ResponseError }
            from ${JSON.stringify(import.meta.resolve("vscode-jsonrpc/node.js"))};
          const log = (value) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(value) + "\\n");
          log({ args: process.argv.slice(2), marker: process.env.ACCOUNT_HOME_MARKER });
          if (${JSON.stringify(scenario)} === "exit") process.exit(1);
          const connection = createMessageConnection(
            new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout)
          );
          connection.onRequest((method) => {
            log({ method });
            if (method === "connect") {
              if (${JSON.stringify(scenario)} === "legacy") throw new ResponseError(-32601, "unknown");
              return { protocolVersion: 3 };
            }
            if (method === "ping") return { protocolVersion: 3 };
            if (method === "auth.getStatus" && ${JSON.stringify(scenario)} === "hang")
              return new Promise(() => {});
            if (method === "auth.getStatus") return {
              isAuthenticated: ${scenario !== "signed-out"},
              login: "ExampleAccount", host: "github.com"
            };
            if (method === "account.getQuota") {
              if (${JSON.stringify(scenario)} === "quota-error")
                throw new ResponseError(-32603, "Sensitive runtime details must not escape");
              return ${JSON.stringify(quotaResponse)};
            }
            throw new ResponseError(-32601, "No generation methods permitted");
          });
          connection.listen();
        `,
      });
      const catalog = AcpRegistrySupport.AcpRegistryCatalog.of({
        search: () => Effect.die("unused"),
        inspect: () =>
          Effect.succeed({
            status: "ready" as const,
            agentId: "local",
            version: "1.0",
            distribution: "local" as const,
          }),
        prepare: () => Effect.die("unused"),
        uninstallManagedBinary: () => Effect.die("unused"),
        resolve: (_settings, cwd, environment) =>
          Effect.succeed({
            distribution: "local" as const,
            spawn: { command, args: ["--acp"], cwd, ...(environment ? { env: environment } : {}) },
          }),
      });
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawned = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const response = yield* Deferred.make<void>();
      const trackingSpawner = ChildProcessSpawner.make((command) =>
        spawner.spawn(command).pipe(
          Effect.tap((child) => Deferred.succeed(spawned, child)),
          Effect.map((child) => ({
            ...child,
            stdout: child.stdout.pipe(Stream.tap(() => Deferred.succeed(response, undefined))),
          })),
        ),
      );
      const result = yield* Effect.gen(function* () {
        if (throughDriver) {
          const instance = yield* AcpRegistryDriver.create({
            instanceId: ProviderInstanceId.make("copilot"),
            displayName: "Copilot CLI",
            accentColor: undefined,
            enabled: true,
            environment: [
              { name: "ACCOUNT_HOME_MARKER", value: "isolated-account", sensitive: false },
            ],
            config: settings({ source: "local", commandPath: command }),
          });
          const snapshot = yield* instance.snapshot.getSnapshot;
          expect(snapshot.usageLimits).toBeDefined();
          return snapshot.usageLimits!;
        }
        const service = yield* make;
        const read = service.read({
          settings: settings({ source: "local", commandPath: command }),
          cwd: directory,
          environment: { ...process.env, ACCOUNT_HOME_MARKER: "isolated-account" },
        });
        if (scenario !== "hang") return yield* read;
        const fiber = yield* Effect.forkScoped(read);
        yield* Deferred.await(response);
        yield* TestClock.adjust("20 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, trackingSpawner),
      );
      expect(yield* (yield* Deferred.await(spawned)).isRunning).toBe(false);
      const requests = NodeFS.readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      return { result, requests };
    });
  }

  it.effect("reads framed quotas with the instance environment and never creates a session", () =>
    runProbe("normal").pipe(
      Effect.map(({ result, requests }) => {
        expect(result.windows[0]?.usedPercent).toBe(25);
        expect(result.credentialFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(requests).toEqual([
          { args: ["--headless", "--stdio", "--no-auto-update"], marker: "isolated-account" },
          { method: "connect" },
          { method: "auth.getStatus" },
          { method: "account.getQuota" },
        ]);
      }),
    ),
  );
  it.effect("falls back to ping for legacy runtimes", () =>
    runProbe("legacy").pipe(
      Effect.map(({ result, requests }) => {
        expect(result.windows[0]?.usedPercent).toBe(25);
        expect(requests.map((request) => request.method).filter(Boolean)).toEqual([
          "connect",
          "ping",
          "auth.getStatus",
          "account.getQuota",
        ]);
      }),
    ),
  );
  it.effect("clears signed-out allowances without calling account.getQuota", () =>
    runProbe("signed-out").pipe(
      Effect.map(({ result, requests }) => {
        expect(result.unavailable?.reason).toBe("unsupported");
        expect(result.credentialFingerprint).toBeUndefined();
        expect(requests).toHaveLength(3);
      }),
    ),
  );
  it.effect("reports safe failures tied to the current account", () =>
    runProbe("quota-error").pipe(
      Effect.map(({ result }) => {
        expect(result.windows).toEqual([]);
        expect(result.unavailable?.reason).toBe("probeFailed");
        expect(result.credentialFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(result.unavailable?.message).not.toContain("Sensitive");
      }),
    ),
  );
  it.effect("bounds stalled probes and terminates only the owned child", () =>
    runProbe("hang").pipe(
      Effect.map(({ result }) => {
        expect(result.windows).toEqual([]);
        expect(result.unavailable?.reason).toBe("probeFailed");
        expect(result.credentialFingerprint).toBe("copilot:unknown");
      }),
    ),
  );
  it.effect("finishes a failed probe when the CLI exits", () =>
    runProbe("exit").pipe(
      Effect.map(({ result }) => {
        expect(result.unavailable?.reason).toBe("probeFailed");
      }),
    ),
  );
  it.effect("publishes allowances in managed snapshots without an ACP conversation", () =>
    runProbe("normal", true).pipe(
      Effect.map(({ result, requests }) => {
        expect(result.windows[0]?.usedPercent).toBe(25);
        expect(requests.map((request) => request.method).filter(Boolean)).toEqual([
          "connect",
          "auth.getStatus",
          "account.getQuota",
        ]);
      }),
    ),
  );
});
