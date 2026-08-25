import { createInterface, type Interface } from "node:readline";

export interface PromptIo {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
}

/**
 * Minimal interactive prompter over injected streams, so tests can script a
 * whole wizard run through a PassThrough. One persistent readline interface
 * for the prompter's lifetime: a fresh interface per question would buffer a
 * piped multi-line answer chunk internally and discard the rest on close.
 */
export class Prompter {
  private readonly rl: Interface;
  private readonly output: NodeJS.WritableStream;
  private muted = false;
  private closed = false;
  // Piped input can deliver many answers in one chunk; readline emits them as
  // `line` events whether or not a question is pending, so unconsumed lines
  // must be queued — rl.question() would silently drop them between prompts.
  private readonly lines: string[] = [];
  private waiter: { resolve: (line: string) => void; reject: (err: Error) => void } | null = null;

  constructor(io: PromptIo) {
    this.output = io.output;
    this.rl = createInterface({
      input: io.input,
      output: io.output,
      terminal: io.input.isTTY === true,
    });
    // Echo suppression for askHidden(): in terminal mode readline echoes every
    // keystroke through this internal hook; while muted, swallow it. Non-TTY
    // input never echoes, so the hook being absent there is fine.
    const rlInternal = this.rl as unknown as { _writeToOutput?: (s: string) => void };
    const original = rlInternal._writeToOutput?.bind(this.rl);
    if (original) {
      rlInternal._writeToOutput = (s: string): void => {
        if (!this.muted) original(s);
      };
    }
    this.rl.on("line", (line) => {
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w.resolve(line);
      } else {
        this.lines.push(line);
      }
    });
    this.rl.on("close", () => {
      this.closed = true;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w.reject(new Error("input closed"));
      }
    });
    // Ctrl-C during a question: end the wizard instead of leaving readline in
    // its default paused state. question() below rejects via the close event.
    this.rl.on("SIGINT", () => {
      this.output.write("\n");
      this.rl.close();
    });
  }

  say(text: string): void {
    this.output.write(text + "\n");
  }

  private question(prompt: string): Promise<string> {
    this.output.write(prompt);
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(new Error("input closed"));
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  /**
   * Ask for a line of input. An empty answer returns `def` when one is given
   * (shown in brackets). Re-asks while `validate` returns an error string.
   */
  async ask(
    label: string,
    opts: { def?: string; validate?: (value: string) => string | null } = {},
  ): Promise<string> {
    for (;;) {
      const suffix = opts.def ? ` [${opts.def}]` : "";
      const raw = (await this.question(`${label}${suffix}: `)).trim();
      const value = raw === "" && opts.def !== undefined ? opts.def : raw;
      const error = opts.validate?.(value) ?? null;
      if (error === null) return value;
      this.say(`  ${error}`);
    }
  }

  /** Ask without echoing the typed input (passwords). */
  async askHidden(label: string): Promise<string> {
    this.output.write(`${label}: `);
    this.muted = true;
    try {
      return await this.question("");
    } finally {
      this.muted = false;
      this.output.write("\n");
    }
  }

  async askYesNo(label: string, def: boolean): Promise<boolean> {
    const hint = def ? "Y/n" : "y/N";
    for (;;) {
      const raw = (await this.question(`${label} [${hint}]: `)).trim().toLowerCase();
      if (raw === "") return def;
      if (raw === "y" || raw === "yes") return true;
      if (raw === "n" || raw === "no") return false;
      this.say("  Please answer y or n.");
    }
  }

  async askChoice(label: string, choices: string[], def: string): Promise<string> {
    return this.ask(`${label} (${choices.join("/")})`, {
      def,
      validate: (v) => (choices.includes(v) ? null : `Must be one of: ${choices.join(", ")}`),
    });
  }

  close(): void {
    this.rl.close();
  }
}
