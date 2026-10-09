// @effect-diagnostics-next-line nodeBuiltinImport:off -- vscode-jsonrpc requires native Node stdio streams.
import * as NodeStream from "node:stream";

import * as PlatformNodeStream from "@effect/platform-node/NodeStream";
import { type ServerProviderUsageLimits, type ServerProviderUsageWindow } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  createMessageConnection,
  ErrorCodes,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node.js";

import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import type { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";

const USAGE_URL = "https://github.com/settings/billing";
const AuthStatus = Schema.Struct({
  isAuthenticated: Schema.Boolean,
  login: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
});
const QuotaSnapshot = Schema.Struct({
  isUnlimitedEntitlement: Schema.Boolean,
  entitlementRequests: Schema.Number,
  remainingPercentage: Schema.Number,
  resetDate: Schema.optional(Schema.String),
});
const Quotas = Schema.Struct({
  quotaSnapshots: Schema.Record(Schema.String, QuotaSnapshot),
});
const decodeAuthStatus = Schema.decodeUnknownEffect(AuthStatus);
const decodeQuotas = Schema.decodeUnknownOption(Quotas);

export function isCopilotCli(settings: AcpRegistrySettings): boolean {
  return settings.source === "registry"
    ? settings.agentId === "github-copilot-cli"
    : /(?:^|[/\\])copilot(?:\.exe|\.cmd)?$/i.test(settings.commandPath);
}

/** Only account-selection arguments are safe for an account-only headless process. */
export function copilotQuotaArgs(args: readonly string[]): readonly string[] {
  const selected: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--config-dir" || arg === "--auth-token-env") {
      const value = args[++index];
      if (!value || value.startsWith("-")) throw new Error("Missing Copilot account argument.");
      selected.push(arg, value);
    } else if (arg.startsWith("--config-dir=") || arg.startsWith("--auth-token-env=")) {
      selected.push(arg);
    } else if (arg !== "--acp") {
      throw new Error("Unsupported arguments for Copilot account quota probing.");
    }
  }
  return [...selected, "--headless", "--stdio", "--no-auto-update"];
}

export function copilotQuotaToLimits(
  value: unknown,
  checkedAt: string,
  credentialFingerprint: string,
): ServerProviderUsageLimits {
  const decoded = decodeQuotas(value);
  if (Option.isNone(decoded)) {
    return {
      ...makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Copilot returned invalid account quotas.",
      }),
      credentialFingerprint,
    };
  }
  const windows: ServerProviderUsageWindow[] = [];
  for (const [id, quota] of Object.entries(decoded.value.quotaSnapshots)) {
    if (quota.isUnlimitedEntitlement || quota.entitlementRequests === -1) continue;
    if (quota.entitlementRequests === 0) continue;
    if (
      !Number.isFinite(quota.entitlementRequests) ||
      quota.entitlementRequests < 0 ||
      !Number.isFinite(quota.remainingPercentage) ||
      quota.remainingPercentage < 0 ||
      quota.remainingPercentage > 100
    ) {
      return {
        ...makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Copilot returned invalid account quotas.",
        }),
        credentialFingerprint,
      };
    }
    const reset = DateTime.make(quota.resetDate ?? "");
    windows.push({
      id: `copilot_${id}`,
      kind: "monthly",
      label:
        id === "premium_interactions"
          ? "Copilot premium requests"
          : id === "chat"
            ? "Copilot chat"
            : id === "completions"
              ? "Copilot completions"
              : `Copilot ${id.replace(/[_-]/g, " ").slice(0, 80)}`,
      usedPercent: 100 - quota.remainingPercentage,
      ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
    });
  }
  return windows.length > 0
    ? { checkedAt, windows, credentialFingerprint }
    : {
        ...makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message:
            "Copilot reports no finite account quota windows (the allowance may be unlimited).",
        }),
        credentialFingerprint,
        externalUsage: { label: "GitHub Copilot billing", url: USAGE_URL },
      };
}

export class CopilotUsageLimits extends Context.Service<
  CopilotUsageLimits,
  {
    readonly read: (input: {
      readonly settings: AcpRegistrySettings;
      readonly cwd: string;
      readonly environment: NodeJS.ProcessEnv;
    }) => Effect.Effect<ServerProviderUsageLimits>;
  }
>()("@t3tools/provider-acp-registry/server/copilotUsageLimits") {}

export const make = Effect.gen(function* () {
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const read: CopilotUsageLimits["Service"]["read"] = Effect.fn("CopilotUsageLimits.read")(
    function* (input) {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const resolved = yield* catalog.resolve(input.settings, input.cwd, input.environment);
          const args = yield* Effect.try(() => copilotQuotaArgs(resolved.spawn.args));
          const environment = { ...resolved.spawn.env };
          delete environment.NODE_DEBUG;
          const command = yield* resolveSpawnCommand(resolved.spawn.command, args, {
            env: environment,
            extendEnv: false,
          });
          const child = yield* spawner.spawn(
            ChildProcess.make(command.command, command.args, {
              cwd: input.cwd,
              env: environment,
              extendEnv: false,
              shell: command.shell,
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
            }),
          );
          yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
          const output = yield* PlatformNodeStream.toReadable(child.stdout);
          const stdin = new NodeStream.PassThrough();
          yield* PlatformNodeStream.fromReadable({
            evaluate: () => stdin,
            onError: (cause) => cause,
          }).pipe(Stream.run(child.stdin), Effect.forkScoped);
          const connection = createMessageConnection(
            new StreamMessageReader(output),
            new StreamMessageWriter(stdin),
          );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              connection.dispose();
              output.destroy();
              stdin.destroy();
            }),
          );
          connection.onClose(() => connection.dispose());
          connection.listen();
          const request = (method: string) =>
            Effect.tryPromise(() => connection.sendRequest<unknown>(method, {}));
          // Match the official SDK handshake, including pre-connect CLI builds.
          yield* request("connect").pipe(
            Effect.catchIf(
              (cause) =>
                cause.cause instanceof ResponseError &&
                (cause.cause.code === ErrorCodes.MethodNotFound ||
                  cause.cause.message === "Unhandled method connect"),
              () => request("ping"),
            ),
          );
          const auth = yield* request("auth.getStatus").pipe(Effect.flatMap(decodeAuthStatus));
          if (!auth.isAuthenticated) {
            return makeUnavailableUsageLimits({
              checkedAt,
              reason: "unsupported",
              message: "Sign in to Copilot CLI to read subscription quotas.",
            });
          }
          if (!auth.login?.trim()) {
            return {
              ...makeUnavailableUsageLimits({
                checkedAt,
                reason: "probeFailed",
                message: "Copilot did not report an account identity for its subscription quotas.",
              }),
              credentialFingerprint: "copilot:unknown",
            };
          }
          const fingerprint = Hex.encode(
            yield* crypto.digest(
              "SHA-256",
              new TextEncoder().encode(
                `copilot:${(auth.host ?? "github.com").toLowerCase()}:${auth.login.trim().toLowerCase()}`,
              ),
            ),
          );
          return yield* request("account.getQuota").pipe(
            Effect.map((quotas) => copilotQuotaToLimits(quotas, checkedAt, fingerprint)),
            Effect.catchCause(() =>
              Effect.succeed({
                ...makeUnavailableUsageLimits({
                  checkedAt,
                  reason: "probeFailed",
                  message:
                    "Copilot account quotas could not be read. Update Copilot CLI and retry.",
                }),
                credentialFingerprint: fingerprint,
              }),
            ),
          );
        }),
      ).pipe(
        Effect.timeout("20 seconds"),
        Effect.catchCause(() =>
          Effect.succeed({
            ...makeUnavailableUsageLimits({
              checkedAt,
              reason: "probeFailed",
              message: "Copilot account quotas could not be read. Update Copilot CLI and retry.",
            }),
            credentialFingerprint: "copilot:unknown",
          }),
        ),
      );
    },
  );
  return CopilotUsageLimits.of({ read });
});

export const layer = Layer.effect(CopilotUsageLimits, make);
