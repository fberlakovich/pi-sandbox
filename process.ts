import { spawn } from "node:child_process";

export interface ProcessRunResult {
	code: number | null;
	stdout: Buffer;
	stderr: Buffer;
}

export interface ProcessRunOptions {
	signal?: AbortSignal;
	timeout?: number;
	input?: string | Buffer;
	onData?: (chunk: Buffer) => void;
	cwd?: string;
}

export function toText(buffer: Buffer): string {
	return buffer.toString("utf-8");
}

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function splitLines(text: string): string[] {
	const lines = normalizeLineEndings(text).split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

export function splitNonEmptyLines(text: string): string[] {
	return normalizeLineEndings(text)
		.split("\n")
		.filter((line) => line.length > 0);
}

export function textToolResult(text: string, details?: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

export function formatProcessError(prefix: string, result: ProcessRunResult): Error {
	const stderr = toText(result.stderr).trim();
	const stdout = toText(result.stdout).trim();
	const message = stderr || stdout || `exit code ${result.code ?? "unknown"}`;
	return new Error(`${prefix}: ${message}`);
}

export function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function killChild(child: ReturnType<typeof spawn>): void {
	if (!child.pid) {
		child.kill("SIGKILL");
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

export function runProcess(
	command: string,
	args: string[],
	options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			detached: true,
			cwd: options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let timedOut = false;
		let timeoutHandle: NodeJS.Timeout | undefined;

		if (options.timeout !== undefined && options.timeout > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				killChild(child);
			}, options.timeout * 1000);
		}

		child.stdout?.on("data", (chunk) => {
			const buffer = Buffer.from(chunk);
			stdoutChunks.push(buffer);
			options.onData?.(buffer);
		});

		child.stderr?.on("data", (chunk) => {
			const buffer = Buffer.from(chunk);
			stderrChunks.push(buffer);
			options.onData?.(buffer);
		});

		child.on("error", (error) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			options.signal?.removeEventListener("abort", onAbort);
			reject(error);
		});

		const onAbort = () => {
			killChild(child);
		};

		if (options.signal?.aborted) {
			onAbort();
		} else {
			options.signal?.addEventListener("abort", onAbort, { once: true });
		}

		if (options.input !== undefined) {
			child.stdin?.write(options.input);
		}
		child.stdin?.end();

		child.on("close", (code) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			options.signal?.removeEventListener("abort", onAbort);

			if (options.signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}
			if (timedOut) {
				reject(new Error(`timeout:${options.timeout}`));
				return;
			}

			resolve({
				code,
				stdout: Buffer.concat(stdoutChunks),
				stderr: Buffer.concat(stderrChunks),
			});
		});
	});
}
