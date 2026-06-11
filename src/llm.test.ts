import { describe, it, expect, vi, beforeEach } from "vitest";
process.env.AGENT_CYA_MIN_ASK_MS = "0";
import { padAskDecision, parseLlmResponse, review } from "./llm.ts";

describe("parseLlmResponse", () => {
  it("parses valid allow decision", () => {
    const result = parseLlmResponse(
      JSON.stringify({ decision: "allow", reason: "safe command" }),
    );
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("safe command");
  });

  it("parses valid deny decision", () => {
    const result = parseLlmResponse(
      JSON.stringify({ decision: "deny", reason: "dangerous" }),
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("dangerous");
  });

  it("parses valid ask decision", () => {
    const result = parseLlmResponse(
      JSON.stringify({ decision: "ask", reason: "needs review" }),
    );
    expect(result.decision).toBe("ask");
    expect(result.reason).toBe("needs review");
  });

  it("handles markdown code block", () => {
    const result = parseLlmResponse(
      '```json\n{"decision": "allow", "reason": "safe"}\n```',
    );
    expect(result.decision).toBe("allow");
  });

  it("handles bare JSON in text", () => {
    const result = parseLlmResponse(
      'Here is my analysis: {"decision": "deny", "reason": "risky"}',
    );
    expect(result.decision).toBe("deny");
  });

  it("falls back to ask for invalid JSON", () => {
    const result = parseLlmResponse("not json at all");
    expect(result.decision).toBe("ask");
    expect(result.reason).toBe("Invalid LLM response, needs review");
  });

  it("falls back to ask for missing decision field", () => {
    const result = parseLlmResponse(JSON.stringify({ reason: "test" }));
    expect(result.decision).toBe("ask");
  });

  it("falls back to ask for invalid decision value", () => {
    const result = parseLlmResponse(
      JSON.stringify({ decision: "maybe", reason: "unsure" }),
    );
    expect(result.decision).toBe("ask");
  });

  it("handles missing reason gracefully", () => {
    const result = parseLlmResponse(JSON.stringify({ decision: "allow" }));
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("No reason provided");
  });
});

describe("review", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("spawns claude binary for claude platform", async () => {
    const mockSpawn = vi.fn().mockReturnValue({
      stdout: {
        on: (_: string, handler: (data: Buffer) => void) => {
          handler(Buffer.from('{"decision": "allow", "reason": "safe"}'));
        },
      },
      stderr: { on: () => {} },
      on: (event: string, handler: (val: number | Error) => void) => {
        if (event === "close") handler(0);
      },
    });

    const result = await review(
      { toolType: "Bash", command: "ls", fileContent: null },
      "claude",
      mockSpawn,
    );

    expect(result.decision).toBe("allow");
    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["-p"]),
      expect.any(Object),
    );
  });

  it("spawns opencode binary for opencode platform", async () => {
    const mockSpawn = vi.fn().mockReturnValue({
      stdout: {
        on: (_: string, handler: (data: Buffer) => void) => {
          handler(Buffer.from('{"decision": "deny", "reason": "dangerous"}'));
        },
      },
      stderr: { on: () => {} },
      on: (event: string, handler: (val: number | Error) => void) => {
        if (event === "close") handler(0);
      },
    });

    const result = await review(
      { toolType: "Bash", command: "rm -rf /", fileContent: null },
      "opencode",
      mockSpawn,
    );

    expect(result.decision).toBe("deny");
    expect(mockSpawn).toHaveBeenCalledWith(
      "opencode",
      expect.arrayContaining(["run"]),
      expect.any(Object),
    );
  });

  it("returns ask fallback on spawn error", async () => {
    const mockSpawn = vi.fn().mockReturnValue({
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event: string, handler: (val: number | Error) => void) => {
        if (event === "error") handler(new Error("ENOENT"));
      },
    });

    const result = await review(
      { toolType: "Bash", command: "ls", fileContent: null },
      "claude",
      mockSpawn,
    );

    expect(result.decision).toBe("ask");
    expect(result.reason).toBe("LLM unavailable, needs human review");
  });

  it("returns ask fallback on binary non-zero exit", async () => {
    const mockSpawn = vi.fn().mockReturnValue({
      stdout: { on: () => {} },
      stderr: {
        on: (_: string, handler: (data: Buffer) => void) => {
          handler(Buffer.from("binary error"));
        },
      },
      on: (event: string, handler: (val: number | Error) => void) => {
        if (event === "close") handler(1);
      },
    });

    const result = await review(
      { toolType: "Bash", command: "ls", fileContent: null },
      "claude",
      mockSpawn,
    );

    expect(result.decision).toBe("ask");
    expect(result.reason).toBe("LLM unavailable, needs human review");
  });

  describe("padAskDecision", () => {
    beforeEach(() => {
      process.env.AGENT_CYA_MIN_ASK_MS = "60000";
    });

    it("sleeps the remaining ms when ask arrives early", async () => {
      const fakeSleep = vi.fn().mockResolvedValue(undefined);
      const result = await padAskDecision(
        { decision: "ask", reason: "unsure" },
        5_000,
        fakeSleep,
      );
      expect(fakeSleep).toHaveBeenCalledWith(55_000);
      expect(result.decision).toBe("ask");
      expect(result.reason).toContain("60s for human input");
    });

    it("does not sleep when already past the minimum", async () => {
      const fakeSleep = vi.fn().mockResolvedValue(undefined);
      const result = await padAskDecision(
        { decision: "ask", reason: "unsure" },
        61_000,
        fakeSleep,
      );
      expect(fakeSleep).not.toHaveBeenCalled();
      expect(result.reason).toBe("unsure");
    });

    it("does not pad allow decisions", async () => {
      const fakeSleep = vi.fn().mockResolvedValue(undefined);
      const result = await padAskDecision(
        { decision: "allow", reason: "safe" },
        0,
        fakeSleep,
      );
      expect(fakeSleep).not.toHaveBeenCalled();
      expect(result).toEqual({ decision: "allow", reason: "safe" });
    });

    it("does not pad deny decisions", async () => {
      const fakeSleep = vi.fn().mockResolvedValue(undefined);
      const result = await padAskDecision(
        { decision: "deny", reason: "destructive" },
        0,
        fakeSleep,
      );
      expect(fakeSleep).not.toHaveBeenCalled();
      expect(result).toEqual({ decision: "deny", reason: "destructive" });
    });

    it("is disabled when AGENT_CYA_MIN_ASK_MS is 0", async () => {
      process.env.AGENT_CYA_MIN_ASK_MS = "0";
      const fakeSleep = vi.fn().mockResolvedValue(undefined);
      const result = await padAskDecision(
        { decision: "ask", reason: "unsure" },
        0,
        fakeSleep,
      );
      expect(fakeSleep).not.toHaveBeenCalled();
      expect(result.reason).toBe("unsure");
    });
  });

  it("returns ask fallback on malformed binary output", async () => {
    const mockSpawn = vi.fn().mockReturnValue({
      stdout: {
        on: (_: string, handler: (data: Buffer) => void) => {
          handler(Buffer.from("this is not json"));
        },
      },
      stderr: { on: () => {} },
      on: (event: string, handler: (val: number | Error) => void) => {
        if (event === "close") handler(0);
      },
    });

    const result = await review(
      { toolType: "Bash", command: "ls", fileContent: null },
      "claude",
      mockSpawn,
    );

    expect(result.decision).toBe("ask");
    expect(result.reason).toBe("Invalid LLM response, needs review");
  });
});
