import { execFile } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  /** Return the result instead of throwing when the command exits non-zero. */
  allowFailure?: boolean;
  timeoutMs?: number;
  /** Environment for the command; defaults to the gateway's own. */
  env?: NodeJS.ProcessEnv;
}

/** Runs system commands. Everything that touches the kernel goes through this, so tests can fake it. */
export interface CommandRunner {
  run(command: string, args: string[], options?: RunOptions): Promise<CommandResult>;
}

export class CommandError extends Error {
  readonly result: CommandResult;

  constructor(command: string, args: string[], result: CommandResult) {
    super(`${command} ${args.join(" ")} failed (${String(result.code)}): ${result.stderr.trim()}`);
    this.name = "CommandError";
    this.result = result;
  }
}

/** Executes commands with `execFile`: arguments are passed as an array and no shell is involved. */
export class SystemRunner implements CommandRunner {
  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    const result = await new Promise<CommandResult>((resolve) => {
      execFile(
        command,
        args,
        { timeout: options.timeoutMs ?? 15_000, maxBuffer: 32 * 1024 * 1024, env: options.env ?? process.env },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
          resolve({ stdout, stderr: stderr || (error?.message ?? ""), code });
        },
      );
    });
    if (result.code !== 0 && options.allowFailure !== true) {
      throw new CommandError(command, args, result);
    }
    return result;
  }
}
