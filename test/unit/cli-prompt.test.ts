import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { Prompter, type PromptIo } from "../../src/cli/prompt.js";

function makeIo(text?: string): { io: PromptIo; input: PassThrough; output: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = "";
  output.on("data", (chunk) => (out += String(chunk)));
  if (text !== undefined) input.end(text);
  return { io: { input, output }, input, output: () => out };
}

describe("Prompter", () => {
  it("returns the trimmed answer", async () => {
    const { io } = makeIo("  debmatic  \n");
    const ui = new Prompter(io);
    expect(await ui.ask("Host")).toBe("debmatic");
    ui.close();
  });

  it("falls back to the default on empty input and shows it in the prompt", async () => {
    const { io, output } = makeIo("\n");
    const ui = new Prompter(io);
    expect(await ui.ask("CCU user", { def: "Admin" })).toBe("Admin");
    expect(output()).toContain("[Admin]");
    ui.close();
  });

  it("re-asks while validate rejects", async () => {
    const { io, output } = makeIo("nope\n42\n");
    const ui = new Prompter(io);
    const answer = await ui.ask("Port", {
      validate: (v) => (/^\d+$/.test(v) ? null : "Digits only."),
    });
    expect(answer).toBe("42");
    expect(output()).toContain("Digits only.");
    ui.close();
  });

  // The regression this design exists for: piped input delivers every answer
  // in ONE chunk before the second question is even asked. rl.question()
  // would emit the excess lines with no listener attached and drop them.
  it("answers multiple questions from a single buffered chunk", async () => {
    const { io } = makeIo("one\ntwo\nthree\n");
    const ui = new Prompter(io);
    expect(await ui.ask("A")).toBe("one");
    await new Promise((r) => setTimeout(r, 10)); // let any stray events fire
    expect(await ui.ask("B")).toBe("two");
    expect(await ui.ask("C")).toBe("three");
    ui.close();
  });

  it("parses yes/no with a default", async () => {
    const { io, output } = makeIo("\ny\nno\nmaybe\nn\n");
    const ui = new Prompter(io);
    expect(await ui.askYesNo("Q1", true)).toBe(true); // empty -> default
    expect(await ui.askYesNo("Q2", false)).toBe(true);
    expect(await ui.askYesNo("Q3", true)).toBe(false);
    expect(await ui.askYesNo("Q4", true)).toBe(false); // "maybe" re-asks, then "n"
    expect(output()).toContain("Please answer y or n.");
    ui.close();
  });

  it("askChoice accepts only listed values", async () => {
    const { io, output } = makeIo("staging\ndev\n");
    const ui = new Prompter(io);
    expect(await ui.askChoice("Default target", ["prod", "dev"], "prod")).toBe("dev");
    expect(output()).toContain("Must be one of: prod, dev");
    ui.close();
  });

  it("askHidden returns the answer without echoing it", async () => {
    const { io, output } = makeIo("s3cret\n");
    const ui = new Prompter(io);
    expect(await ui.askHidden("Password")).toBe("s3cret");
    expect(output()).toContain("Password: ");
    expect(output()).not.toContain("s3cret");
    ui.close();
  });

  it("rejects a pending question when the input closes", async () => {
    const { io, input } = makeIo();
    const ui = new Prompter(io);
    const pending = ui.ask("Host");
    input.end();
    await expect(pending).rejects.toThrow("input closed");
  });

  it("rejects new questions after close", async () => {
    const { io } = makeIo("only-line\n");
    const ui = new Prompter(io);
    expect(await ui.ask("A")).toBe("only-line");
    ui.close();
    await expect(ui.ask("B")).rejects.toThrow("input closed");
  });
});
