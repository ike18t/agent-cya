import { describe, it, expect, vi, beforeEach } from "vitest";
process.env.AGENT_CYA_MIN_ASK_MS = "0";
import { parseInput } from "./cli.ts";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { runReview } from "./cli.ts";
import * as childProcess from "node:child_process";

describe("parseInput", () => {
  it("parses valid input", () => {
    const result = parseInput(
      JSON.stringify({
        toolType: "Bash",
        command: "npm test",
        fileContent: null,
        workingDirectory: "/home/user/project",
      }),
    );
    expect(result.toolType).toBe("Bash");
    expect(result.command).toBe("npm test");
    expect(result.fileContent).toBeNull();
    expect(result.workingDirectory).toBe("/home/user/project");
  });

  it("handles missing optional fields", () => {
    const result = parseInput(
      JSON.stringify({ toolType: "Write", command: "src/file.ts" }),
    );
    expect(result.toolType).toBe("Write");
    expect(result.command).toBe("src/file.ts");
    expect(result.fileContent).toBeNull();
    expect(result.workingDirectory).toBeUndefined();
  });

  it("throws on missing toolType", () => {
    expect(() => parseInput(JSON.stringify({ command: "ls" }))).toThrow(
      "missing or invalid 'toolType'",
    );
  });

  it("throws on missing command", () => {
    expect(() => parseInput(JSON.stringify({ toolType: "Bash" }))).toThrow(
      "missing or invalid 'command'",
    );
  });

  it("throws on invalid JSON", () => {
    expect(() => parseInput("not json")).toThrow();
  });
});

const buffers = {
  stdout: [] as string[],
  stderr: [] as string[],
};

describe("runReview", () => {
  beforeEach(() => {
    buffers.stdout = [];
    buffers.stderr = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      buffers.stdout.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      buffers.stderr.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
  });

  it("denies hard deny commands without calling LLM", async () => {
    const result = await runReview(
      JSON.stringify({
        toolType: "Bash",
        command: "rm -rf /",
        fileContent: null,
      }),
      "claude",
    );

    expect(result).toBe(1);
    const output = JSON.parse(buffers.stdout.join(""));
    expect(output.decision).toBe("deny");
    expect(output.reason).toContain("denied pattern");
  });

  it("passes safe commands through to LLM", async () => {
    vi.mocked(childProcess.spawn).mockReturnValue({
      stdout: {
        on: (_: string, handler: (data: Buffer) => void) => {
          handler(
            Buffer.from('{"decision": "allow", "reason": "safe command"}'),
          );
        },
      } as never,
      stderr: { on: () => {} } as never,
      on: (event: string, handler: (val: number) => void) => {
        if (event === "close") handler(0);
      },
    } as never);

    const result = await runReview(
      JSON.stringify({
        toolType: "Bash",
        command: "ls",
        fileContent: null,
      }),
      "claude",
    );

    expect(result).toBe(0);
    const output = JSON.parse(buffers.stdout.join(""));
    expect(output.decision).toBe("allow");
  });

  it("returns ask on LLM spawn failure", async () => {
    vi.mocked(childProcess.spawn).mockReturnValue({
      stdout: { on: () => {} } as never,
      stderr: { on: () => {} } as never,
      on: (event: string, handler: (val: Error) => void) => {
        if (event === "error") handler(new Error("ENOENT"));
      },
    } as never);

    const result = await runReview(
      JSON.stringify({
        toolType: "Bash",
        command: "ls",
        fileContent: null,
      }),
      "claude",
    );

    expect(result).toBe(0);
    const output = JSON.parse(buffers.stdout.join(""));
    expect(output.decision).toBe("ask");
  });

  it("handles invalid JSON input gracefully", async () => {
    const result = await runReview("not valid json", "claude");
    expect(result).toBe(1);
    expect(buffers.stderr.join("")).toContain("agent-cya");
  });
});
