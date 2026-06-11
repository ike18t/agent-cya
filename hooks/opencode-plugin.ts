import { spawn, ChildProcess } from "node:child_process";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLATFORM = process.env.AGENT_CYA_PLATFORM || "opencode";

export const AgentCyaGuard = async ({
  project,
}: {
  project?: { root?: string };
}) => {
  return {
    "tool.execute.before": async (
      input: { tool: string },
      output: { args: Record<string, unknown> },
    ) => {
      const toolType = input.tool;
      const args = output.args;

      let command: string;
      let fileContent: string | null = null;

      if (toolType === "bash" || toolType === "Bash") {
        command = String(args.command ?? "");
      } else if (toolType === "write" || toolType === "Write") {
        command = String(args.filePath ?? args.file_path ?? "");
        fileContent = args.content ? String(args.content) : null;
      } else if (toolType === "edit" || toolType === "Edit") {
        command = String(args.filePath ?? args.file_path ?? "");
        fileContent = JSON.stringify({
          old_string: args.oldString ?? args.old_string,
          new_string: args.newString ?? args.new_string,
        });
      } else {
        command = String(
          args.command ??
            args.filePath ??
            args.file_path ??
            JSON.stringify(args),
        );
      }

      const agentCyaInput = JSON.stringify({
        toolType,
        command,
        fileContent,
        workingDirectory: project?.root ?? process.cwd(),
      });

      const decision = await spawnAgentCya(agentCyaInput);

      if (decision.decision === "deny") {
        throw new Error(`[agent-cya] Denied: ${decision.reason}`);
      }
      if (decision.decision === "ask") {
        throw new Error(`[agent-cya] Needs review: ${decision.reason}`);
      }
    },
  };
};

type AgentCyaDecision = {
  decision: "allow" | "deny" | "ask";
  reason: string;
};

const SPAWN_TIMEOUT_MS = 30_000;

const spawnAgentCya = (inputJson: string): Promise<AgentCyaDecision> => {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill();
      resolve({
        decision: "deny",
        reason: `agent-cya timed out after ${SPAWN_TIMEOUT_MS}ms`,
      });
    }, SPAWN_TIMEOUT_MS);

    const child: ChildProcess = spawn(
      "node",
      [
        resolvePath(__dirname, "..", "src", "main.ts"),
        "review",
        "--platform",
        PLATFORM,
      ],
      {
        env: {
          ...process.env,
          NODE_NO_WARNINGS: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        const decision = JSON.parse(stdout.trim()) as AgentCyaDecision;
        resolve(decision);
      } catch {
        resolve({
          decision: "deny",
          reason: `agent-cya failed (exit ${code}): ${stderr.trim() || "no output"}`,
        });
      }
    };

    child.on("close", settle);
    child.on("exit", settle);

    child.on("error", (err: Error) => {
      clearTimeout(timeout);
      resolve({
        decision: "deny",
        reason: `agent-cya spawn failed: ${err.message}`,
      });
    });

    child.stdin?.write(inputJson);
    child.stdin?.end();
  });
};
