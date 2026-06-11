import { spawn } from "node:child_process";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.ts";
import type { ReviewInput } from "./prompt.ts";

export type LlmDecision = {
  decision: "allow" | "deny" | "ask";
  reason: string;
};

const SPAWN_TIMEOUT_MS = 90_000;

const DEFAULT_MIN_ASK_MS = 60_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const getMinAskMs = (): number => {
  const raw = process.env.AGENT_CYA_MIN_ASK_MS;
  if (raw === undefined) return DEFAULT_MIN_ASK_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_ASK_MS;
};

export const padAskDecision = async (
  decision: Readonly<LlmDecision>,
  elapsedMs: number,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<LlmDecision> => {
  const minMs = getMinAskMs();
  if (decision.decision !== "ask" || minMs <= 0) return decision;
  const remaining = minMs - elapsedMs;
  if (remaining <= 0) return decision;

  await sleepFn(remaining);
  return {
    decision: "ask",
    reason: `${decision.reason} [agent-cya held ${Math.ceil(minMs / 1000)}s for human input]`,
  };
};

const INVOCATION_FOR_PLATFORM: Record<
  "claude" | "opencode",
  Readonly<{ binary: string; leadingArgs: readonly string[] }>
> = {
  claude: { binary: "claude", leadingArgs: ["-p"] },
  opencode: { binary: "opencode", leadingArgs: ["run"] },
};

const SECRET_PATTERNS = [
  /KEY$/i,
  /TOKEN$/i,
  /SECRET$/i,
  /PASSWORD$/i,
  /_KEY$/i,
  /_TOKEN$/i,
  /_SECRET$/i,
  /_PASSWORD$/i,
];

const sanitizeEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => !value || !SECRET_PATTERNS.some((re) => re.test(key)),
    ),
  ) as NodeJS.ProcessEnv;

const extractJson = (raw: string): string => {
  const trimmed = raw.trim();
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
};

export const parseLlmResponse = (raw: string): LlmDecision => {
  try {
    const jsonStr = extractJson(raw);
    const parsed = JSON.parse(jsonStr);
    const decision = parsed.decision;
    if (decision !== "allow" && decision !== "deny" && decision !== "ask") {
      return { decision: "ask", reason: "Invalid LLM response, needs review" };
    }
    const reason =
      typeof parsed.reason === "string" ? parsed.reason : "No reason provided";
    return { decision, reason };
  } catch {
    return { decision: "ask", reason: "Invalid LLM response, needs review" };
  }
};

/* eslint-disable functional/immutable-data -- callback-based spawn needs mutable accumulator */
const spawnBinary = (
  binary: string,
  args: readonly string[],
  spawnFn: typeof spawn,
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const child = spawnFn(binary, [...args], {
      env: { ...sanitizeEnv(), NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const acc = { stdout: "", stderr: "", settled: false };

    const cleanup = () => {
      if (typeof child?.kill !== "function") {
        process.stderr.write(
          `[agent-cya] cleanup: ${binary} child has unexpected shape ` +
            `(typeof child=${typeof child}, kill=${typeof child?.kill}, killed=${typeof child?.killed})\n`,
        );
        return;
      }
      if (!child.killed) child.kill("SIGTERM");
    };
    const timeout = setTimeout(() => {
      if (acc.settled) return;
      acc.settled = true;
      cleanup();
      reject(new Error(`${binary} timed out after ${SPAWN_TIMEOUT_MS}ms`));
    }, SPAWN_TIMEOUT_MS);
    timeout.unref();

    child.stdout.on("data", (data: Buffer) => {
      acc.stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      acc.stderr += data.toString();
    });

    child.on("close", (code) => {
      if (acc.settled) return;
      acc.settled = true;
      clearTimeout(timeout);
      if (code === 0 && acc.stdout.trim()) {
        resolve(acc.stdout.trim());
      } else {
        reject(
          new Error(
            `${binary} exited ${code}: ${acc.stderr.trim() || "no output"}`,
          ),
        );
      }
    });

    child.on("error", (err) => {
      if (acc.settled) return;
      acc.settled = true;
      clearTimeout(timeout);
      cleanup();
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        process.stderr.write(
          `[agent-cya] ENOENT looking up '${binary}' (PATH=${process.env.PATH ?? "<unset>"})\n`,
        );
      }
      reject(new Error(`Failed to spawn ${binary}: ${err.message}`));
    });
  });
};
/* eslint-enable functional/immutable-data */

const RETRY_DELAY_MS = 500;

type SpawnOutcome = Readonly<{ raw: string } | { error: string }>;

const attemptSpawn = (
  binary: string,
  args: readonly string[],
  spawnFn: typeof spawn,
): Promise<SpawnOutcome> =>
  spawnBinary(binary, args, spawnFn)
    .then((raw): SpawnOutcome => ({ raw }))
    .catch(
      (err): SpawnOutcome => ({
        error: err instanceof Error ? err.message : String(err),
      }),
    );

const callLlm = async (
  invocation: Readonly<{ binary: string; leadingArgs: readonly string[] }>,
  fullPrompt: string,
  spawnFn: typeof spawn,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<LlmDecision> => {
  const args = [...invocation.leadingArgs, fullPrompt];

  const first = await attemptSpawn(invocation.binary, args, spawnFn);
  const final: SpawnOutcome =
    "raw" in first || first.error.includes("timed out")
      ? first
      : await (async () => {
          process.stderr.write(
            `[agent-cya] retrying ${invocation.binary} after: ${first.error}\n`,
          );
          await sleepFn(RETRY_DELAY_MS);
          return attemptSpawn(invocation.binary, args, spawnFn);
        })();

  if ("raw" in final) return parseLlmResponse(final.raw);

  process.stderr.write(
    `[agent-cya] LLM review failed (${invocation.binary}): ${final.error}\n`,
  );
  return {
    decision: "ask",
    reason: `LLM unavailable (${invocation.binary}: ${final.error})`,
  };
};

export const review = async function review(
  input: Readonly<ReviewInput>,
  platform: "opencode" | "claude",
  spawnFn: typeof spawn = spawn,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<LlmDecision> {
  const invocation = INVOCATION_FOR_PLATFORM[platform];
  if (!invocation) {
    return padAskDecision(
      { decision: "ask", reason: `Unknown platform: ${platform}` },
      0,
      sleepFn,
    );
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(input);
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

  const startMs = Date.now();
  const decision = await callLlm(invocation, fullPrompt, spawnFn, sleepFn);
  return padAskDecision(decision, Date.now() - startMs, sleepFn);
};
