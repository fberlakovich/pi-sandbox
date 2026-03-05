import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import test from "node:test";

type RpcEvent = Record<string, unknown>;

const TEST_CWD = process.env.PI_SANDBOX_TEST_CWD ?? process.cwd();

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandExists(command: string): boolean {
	return spawnSync("bash", ["-lc", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function notifyMessages(events: RpcEvent[]): string[] {
	return events
		.filter((event) => event.type === "extension_ui_request" && event.method === "notify")
		.map((event) => String(event.message ?? ""));
}

class RpcClient {
	private process: ChildProcessWithoutNullStreams;
	private readline: Interface;
	private queue: RpcEvent[] = [];
	private requestId = 0;

	constructor(cwd: string) {
		this.process = spawn("pi-work", ["--mode", "rpc", "--no-session"], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.readline = createInterface({ input: this.process.stdout });
		this.readline.on("line", (line) => {
			try {
				this.queue.push(JSON.parse(line));
			} catch {
				// Non-JSON line; ignore.
			}
		});
	}

	async start(): Promise<void> {
		await sleep(750);
		if (this.process.exitCode !== null) {
			throw new Error(`pi-work exited early with code ${this.process.exitCode}`);
		}
		this.drain();
	}

	async prompt(message: string, options?: { timeoutMs?: number; settleMs?: number }): Promise<RpcEvent[]> {
		const timeoutMs = options?.timeoutMs ?? 30_000;
		const settleMs = options?.settleMs ?? 500;
		const id = `req-${++this.requestId}`;
		const command = { id, type: "prompt", message };
		this.process.stdin.write(`${JSON.stringify(command)}\n`);

		const events: RpcEvent[] = [];
		const deadline = Date.now() + timeoutMs;
		let sawResponse = false;
		while (Date.now() < deadline) {
			const event = await this.nextEvent(200);
			if (!event) continue;
			events.push(event);
			if (event.type === "response" && event.id === id) {
				sawResponse = true;
				break;
			}
		}

		if (!sawResponse) {
			throw new Error(`Timed out waiting for response to ${message}`);
		}

		await sleep(settleMs);
		events.push(...this.drain());
		return events;
	}

	async stopSandbox(): Promise<void> {
		try {
			await this.prompt("/sandbox stop", { timeoutMs: 20_000, settleMs: 250 });
		} catch {
			// Best-effort cleanup.
		}
	}

	async close(): Promise<void> {
		this.readline.close();
		if (this.process.exitCode === null) {
			this.process.kill("SIGTERM");
			await sleep(250);
		}
		if (this.process.exitCode === null) {
			this.process.kill("SIGKILL");
		}
	}

	private drain(): RpcEvent[] {
		const events = this.queue;
		this.queue = [];
		return events;
	}

	private async nextEvent(timeoutMs: number): Promise<RpcEvent | undefined> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const event = this.queue.shift();
			if (event) return event;
			await sleep(20);
		}
		return undefined;
	}
}

const canRunIntegration = existsSync(TEST_CWD) && commandExists("pi-work");

test("rpc sandbox lifecycle", { skip: !canRunIntegration, timeout: 240_000 }, async (t) => {
	await t.test("container backend start/status/stop", async (t) => {
		const client = new RpcClient(TEST_CWD);
		await client.start();
		try {
			await client.prompt("/sandbox backend container");
			const startEvents = await client.prompt("/sandbox start", { timeoutMs: 60_000, settleMs: 1_000 });
			const startNotes = notifyMessages(startEvents);
			const startFailure = startNotes.find((msg) => msg.startsWith("Sandbox failed to start:"));
			if (startFailure) {
				t.skip(`container backend unavailable in this environment: ${startFailure}`);
				return;
			}

			assert.ok(startNotes.some((msg) => msg.includes("Container sandbox active")));

			const statusEvents = await client.prompt("/sandbox status", { timeoutMs: 30_000, settleMs: 500 });
			const statusText = notifyMessages(statusEvents).join("\n");
			assert.match(statusText, /Sandbox is running/);
			assert.match(statusText, /Backend: container/);
			assert.match(statusText, /Tools remapped: bash\/read\/write\/edit\/grep\/find\/ls -> container_\*/);
			assert.match(statusText, /Active tools:/);
			assert.match(statusText, /container_bash/);
		} finally {
			await client.stopSandbox();
			await client.close();
		}
	});

	await t.test("runtime backend start/status", async (t) => {
		const client = new RpcClient(TEST_CWD);
		await client.start();
		try {
			await client.prompt("/sandbox backend runtime");
			const startEvents = await client.prompt("/sandbox start", { timeoutMs: 60_000, settleMs: 1_000 });
			const startNotes = notifyMessages(startEvents);
			const startFailure = startNotes.find((msg) => msg.startsWith("Sandbox failed to start:"));
			if (startFailure) {
				t.skip(`runtime backend unavailable in this environment: ${startFailure}`);
				return;
			}

			assert.ok(startNotes.some((msg) => msg.includes("Runtime sandbox active")));

			const statusEvents = await client.prompt("/sandbox status", { timeoutMs: 30_000, settleMs: 500 });
			const statusText = notifyMessages(statusEvents).join("\n");
			assert.match(statusText, /Sandbox is running/);
			assert.match(statusText, /Backend: runtime/);
			assert.match(statusText, /Tools remapped: bash -> container_bash/);
			assert.match(statusText, /Active tools:/);
			assert.match(statusText, /container_bash/);
		} finally {
			await client.stopSandbox();
			await client.close();
		}
	});

	await t.test("engine override is visible in status", async () => {
		const client = new RpcClient(TEST_CWD);
		await client.start();
		try {
			await client.prompt("/sandbox backend container");
			await client.prompt("/sandbox engine apple");
			const statusEvents = await client.prompt("/sandbox status", { timeoutMs: 30_000, settleMs: 500 });
			const statusText = notifyMessages(statusEvents).join("\n");
			assert.match(statusText, /Engine: apple/);
		} finally {
			await client.stopSandbox();
			await client.close();
		}
	});
});
