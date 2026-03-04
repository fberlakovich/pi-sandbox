import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import type {
	BashOperations,
	EditOperations,
	ExtensionAPI,
	ExtensionContext,
	FindOperations,
	LsOperations,
	ReadOperations,
	WriteOperations,
} from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	DEFAULT_MAX_BYTES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type {
	ContainerSandboxConfig,
	HookConfig,
	SandboxConfig,
	SandboxManagerLike,
	SandboxState,
	SessionOverrides,
} from "./config";
import {
	buildEffectiveConfig,
	DEFAULT_CONFIG,
	DEFAULT_CONTAINER_CONFIG,
	DEFAULT_HOOKS,
	DEFAULT_RUNTIME_POLICY,
} from "./config";
import {
	buildContainerExecArgs,
	buildContainerImageInspectArgs,
	buildContainerImagePullArgs,
	buildContainerRemoveArgs,
	buildContainerRunArgs,
	type ContainerEngine,
	getContainerBinary,
	PROJECT_CONTAINER_PATH,
	parseBackend,
	parseEngine,
} from "./container-engine";
import type { ProcessRunOptions, ProcessRunResult } from "./process";
import {
	formatError,
	formatProcessError,
	runProcess,
	splitLines,
	splitNonEmptyLines,
	textToolResult,
	toText,
} from "./process";

interface ContainerExecOptions extends ProcessRunOptions {
	interactive?: boolean;
	tty?: boolean;
}

interface GrepToolParams {
	pattern: string;
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context?: number;
	limit?: number;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

const HOST_TO_CONTAINER_TOOLS: Record<string, string> = {
	bash: "container_bash",
	read: "container_read",
	write: "container_write",
	edit: "container_edit",
	grep: "container_grep",
	find: "container_find",
	ls: "container_ls",
};

const HOST_TO_RUNTIME_TOOLS: Record<string, string> = {
	bash: "container_bash",
};

const SANDBOX_TO_HOST_TOOLS: Record<string, string> = {
	container_bash: "bash",
	container_read: "read",
	container_write: "write",
	container_edit: "edit",
	container_grep: "grep",
	container_find: "find",
	container_ls: "ls",
};

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

let sandboxManagerPromise: Promise<SandboxManagerLike> | undefined;

function normalizePathArg(path: string): string {
	const withoutAt = path.startsWith("@") ? path.slice(1) : path;
	if (withoutAt === "~") return homedir();
	if (withoutAt.startsWith("~/")) return join(homedir(), withoutAt.slice(2));
	return withoutAt;
}

function isInsideProject(absolutePath: string, projectRoot: string): boolean {
	const rel = relative(projectRoot, absolutePath);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveProjectPath(path: string, projectRoot: string): string {
	const normalized = normalizePathArg(path);
	const absolute = isAbsolute(normalized) ? resolvePath(normalized) : resolvePath(projectRoot, normalized);
	if (!isInsideProject(absolute, projectRoot)) {
		throw new Error(`Path is outside project root: ${path}`);
	}
	return absolute;
}

function hostPathToContainerPath(hostPath: string, projectRoot: string): string {
	const safeHostPath = resolveProjectPath(hostPath, projectRoot);
	const rel = relative(projectRoot, safeHostPath).replace(/\\/g, "/");
	if (!rel || rel === ".") return PROJECT_CONTAINER_PATH;
	return `${PROJECT_CONTAINER_PATH}/${rel}`;
}

function containerPathToHostPath(containerPath: string, projectRoot: string): string | undefined {
	const normalized = containerPath.replace(/\\/g, "/");
	if (normalized === PROJECT_CONTAINER_PATH) return projectRoot;
	if (!normalized.startsWith(`${PROJECT_CONTAINER_PATH}/`)) return undefined;
	const rel = normalized.slice(PROJECT_CONTAINER_PATH.length + 1);
	return resolvePath(projectRoot, rel);
}

async function assertContainerEngineAvailable(engine: ContainerEngine): Promise<void> {
	const binary = getContainerBinary(engine);
	const args = engine === "docker" ? ["version", "--format", "{{.Server.Version}}"] : ["--help"];
	const result = await runProcess(binary, args);
	if (result.code !== 0) {
		throw formatProcessError(`${engine} container engine is not available`, result);
	}
}

async function detectContainerShell(
	engine: ContainerEngine,
	containerName: string,
	preferred: string,
): Promise<string> {
	const binary = getContainerBinary(engine);
	const tried = new Set<string>();
	for (const shell of [preferred, "bash", "sh"]) {
		if (!shell || tried.has(shell)) continue;
		tried.add(shell);
		const probe = await runProcess(
			binary,
			buildContainerExecArgs(engine, containerName, [shell, "-lc", "printf ready"], { cwd: PROJECT_CONTAINER_PATH }),
			{ timeout: 10 },
		);
		if (probe.code === 0) return shell;
	}
	throw new Error(`No usable shell found in container (tried: ${Array.from(tried).join(", ")})`);
}

async function pullContainerImage(engine: ContainerEngine, image: string, ctx?: ExtensionContext): Promise<void> {
	const binary = getContainerBinary(engine);
	let carry = "";

	const pullStatus = (line: string): void => {
		if (!ctx?.ui) return;
		const compactLine = line.length > 110 ? `${line.slice(0, 107)}...` : line;
		ctx.ui.setStatus("sandbox-pull", `📥 Pulling ${image} (${engine}): ${compactLine}`);
	};

	const result = await runProcess(binary, buildContainerImagePullArgs(engine, image), {
		timeout: 300,
		onData: (chunk) => {
			carry += toText(chunk).replace(/\r/g, "\n");
			const parts = carry.split("\n");
			carry = parts.pop() ?? "";
			for (const part of parts) {
				const line = part.trim();
				if (!line) continue;
				pullStatus(line);
			}
		},
	});

	if (ctx?.ui) ctx.ui.setStatus("sandbox-pull", undefined);
	if (result.code !== 0) {
		throw formatProcessError(`Failed to pull image ${image}`, result);
	}
}

async function ensureContainerImage(config: ContainerSandboxConfig, ctx?: ExtensionContext): Promise<void> {
	if (config.pullPolicy === "never") return;

	const binary = getContainerBinary(config.engine);
	if (config.pullPolicy === "if-missing") {
		const inspect = await runProcess(binary, buildContainerImageInspectArgs(config.engine, config.image));
		if (inspect.code === 0) return;
	}

	await pullContainerImage(config.engine, config.image, ctx);
}

function stopContainerSync(engine: ContainerEngine, containerName: string): void {
	spawnSync(getContainerBinary(engine), buildContainerRemoveArgs(engine, containerName), { stdio: "ignore" });
}

async function stopContainer(engine: ContainerEngine, containerName: string): Promise<void> {
	await runProcess(getContainerBinary(engine), buildContainerRemoveArgs(engine, containerName));
}

async function startContainer(
	projectRoot: string,
	config: ContainerSandboxConfig,
	ctx?: ExtensionContext,
): Promise<{ containerName: string; shell: string }> {
	await assertContainerEngineAvailable(config.engine);
	await ensureContainerImage(config, ctx);

	const containerName = `pi-sandbox-${process.pid}-${randomUUID().slice(0, 8)}`;
	const started = await runProcess(
		getContainerBinary(config.engine),
		buildContainerRunArgs(projectRoot, config, containerName),
		{ timeout: 30 },
	);
	if (started.code !== 0) {
		throw formatProcessError(`Failed to start ${config.engine} sandbox container`, started);
	}

	try {
		const shell = await detectContainerShell(config.engine, containerName, config.shell);
		return { containerName, shell };
	} catch (error) {
		await stopContainer(config.engine, containerName);
		throw error;
	}
}

interface ContainerRuntime {
	containerName: string;
	containerEngine: ContainerEngine;
	containerShell?: string;
	config: SandboxConfig;
}

function getContainerRuntimeOrThrow(getState: () => SandboxState): ContainerRuntime {
	const state = getState();
	if (!state.active || state.activeBackend !== "container" || !state.containerName || !state.containerEngine) {
		throw new Error("Container sandbox is not active");
	}
	return {
		containerName: state.containerName,
		containerEngine: state.containerEngine,
		containerShell: state.containerShell,
		config: state.config,
	};
}

async function runContainerExec(
	getState: () => SandboxState,
	args: string[],
	options: ContainerExecOptions = {},
): Promise<ProcessRunResult> {
	const runtime = getContainerRuntimeOrThrow(getState);
	const binary = getContainerBinary(runtime.containerEngine);
	const cmdArgs = buildContainerExecArgs(runtime.containerEngine, runtime.containerName, args, options);
	return runProcess(binary, cmdArgs, {
		signal: options.signal,
		timeout: options.timeout,
		input: options.input,
		onData: options.onData,
	});
}

function globToRegex(glob: string): RegExp {
	let normalized = glob.replace(/\\/g, "/").replace(/^\.\//, "");
	if (!normalized.includes("/")) {
		normalized = `**/${normalized}`;
	}

	let regex = "^";
	for (let i = 0; i < normalized.length; i++) {
		const ch = normalized[i];
		if (ch === "*") {
			const next = normalized[i + 1];
			if (next === "*") {
				const after = normalized[i + 2];
				if (after === "/") {
					regex += "(?:.*/)?";
					i += 2;
				} else {
					regex += ".*";
					i += 1;
				}
			} else {
				regex += "[^/]*";
			}
			continue;
		}
		if (ch === "?") {
			regex += "[^/]";
			continue;
		}
		if (/[|\\{}()[\]^$+?.]/.test(ch)) {
			regex += `\\${ch}`;
			continue;
		}
		regex += ch;
	}
	regex += "$";
	return new RegExp(regex);
}

function remapActiveTools(pi: ExtensionAPI, mapping: Record<string, string>): void {
	const active = pi.getActiveTools();
	let changed = false;
	const remapped = active.map((name) => {
		const next = mapping[name];
		if (next) {
			changed = true;
			return next;
		}
		return name;
	});
	if (changed) pi.setActiveTools(remapped);
}

function createContainerReadOps(getState: () => SandboxState, projectRoot: string): ReadOperations {
	return {
		readFile: async (absolutePath) => {
			const containerPath = hostPathToContainerPath(absolutePath, projectRoot);
			const result = await runContainerExec(getState, ["cat", "--", containerPath]);
			if (result.code !== 0) throw formatProcessError(`Failed to read ${absolutePath}`, result);
			return result.stdout;
		},
		access: async (absolutePath) => {
			const containerPath = hostPathToContainerPath(absolutePath, projectRoot);
			const result = await runContainerExec(getState, ["sh", "-lc", 'test -r "$1"', "sh", containerPath]);
			if (result.code !== 0) throw new Error(`Cannot read file: ${absolutePath}`);
		},
		detectImageMimeType: async (absolutePath) => {
			const containerPath = hostPathToContainerPath(absolutePath, projectRoot);
			const byExt = IMAGE_MIME_BY_EXT[extname(absolutePath).toLowerCase()];
			if (byExt) return byExt;

			const result = await runContainerExec(getState, ["sh", "-lc", 'file --mime-type -b "$1"', "sh", containerPath]);
			if (result.code !== 0) return null;
			const mime = toText(result.stdout).trim();
			return Object.values(IMAGE_MIME_BY_EXT).includes(mime) ? mime : null;
		},
	};
}

function createContainerWriteOps(getState: () => SandboxState, projectRoot: string): WriteOperations {
	return {
		mkdir: async (dir) => {
			const containerPath = hostPathToContainerPath(dir, projectRoot);
			const result = await runContainerExec(getState, ["mkdir", "-p", containerPath]);
			if (result.code !== 0) throw formatProcessError(`Failed to create directory ${dir}`, result);
		},
		writeFile: async (absolutePath, content) => {
			const containerPath = hostPathToContainerPath(absolutePath, projectRoot);
			const result = await runContainerExec(getState, ["sh", "-lc", 'cat > "$1"', "sh", containerPath], {
				input: content,
			});
			if (result.code !== 0) throw formatProcessError(`Failed to write file ${absolutePath}`, result);
		},
	};
}

function createContainerEditOps(getState: () => SandboxState, projectRoot: string): EditOperations {
	const readOps = createContainerReadOps(getState, projectRoot);
	const writeOps = createContainerWriteOps(getState, projectRoot);

	return {
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
		access: async (absolutePath) => {
			const containerPath = hostPathToContainerPath(absolutePath, projectRoot);
			const result = await runContainerExec(getState, [
				"sh",
				"-lc",
				'test -r "$1" && test -w "$1"',
				"sh",
				containerPath,
			]);
			if (result.code !== 0) throw new Error(`Cannot edit file: ${absolutePath}`);
		},
	};
}

function createContainerLsOps(getState: () => SandboxState, projectRoot: string): LsOperations {
	return {
		exists: async (absolutePath) => {
			const containerPath = hostPathToContainerPath(absolutePath, projectRoot);
			const result = await runContainerExec(getState, ["test", "-e", containerPath]);
			return result.code === 0;
		},
		stat: async (absolutePath) => {
			const containerPath = hostPathToContainerPath(absolutePath, projectRoot);
			const isDirResult = await runContainerExec(getState, ["test", "-d", containerPath]);
			if (isDirResult.code === 0) {
				return { isDirectory: () => true };
			}

			const existsResult = await runContainerExec(getState, ["test", "-e", containerPath]);
			if (existsResult.code === 0) {
				return { isDirectory: () => false };
			}
			throw new Error(`Path not found: ${absolutePath}`);
		},
		readdir: async (absolutePath) => {
			const containerPath = hostPathToContainerPath(absolutePath, projectRoot);
			const result = await runContainerExec(getState, ["ls", "-A1", "--", containerPath]);
			if (result.code !== 0) throw formatProcessError(`Cannot read directory ${absolutePath}`, result);
			return splitNonEmptyLines(toText(result.stdout));
		},
	};
}

function extractSimpleFindName(glob: string): string | undefined {
	const normalized = glob.replace(/\\/g, "/").replace(/^\.\//, "");
	if (normalized.includes("{") || normalized.includes("}")) return undefined;
	if (!normalized.includes("/")) return normalized;
	if (normalized.startsWith("**/") && !normalized.slice(3).includes("/")) return normalized.slice(3);
	return undefined;
}

function createContainerFindOps(
	getState: () => SandboxState,
	projectRoot: string,
	hasFd: () => Promise<boolean>,
): FindOperations {
	return {
		exists: async (absolutePath) => {
			const containerPath = hostPathToContainerPath(absolutePath, projectRoot);
			const result = await runContainerExec(getState, ["test", "-e", containerPath]);
			return result.code === 0;
		},
		glob: async (pattern, searchCwd, options) => {
			const containerSearchPath = hostPathToContainerPath(searchCwd, projectRoot);
			const effectiveLimit = options.limit ?? 1000;

			if (await hasFd()) {
				const fdArgs = ["fd", "--glob", "--color=never", "--hidden", "--max-results", String(effectiveLimit)];
				for (const ignore of options.ignore ?? []) {
					fdArgs.push("--exclude", ignore);
				}
				fdArgs.push(pattern, containerSearchPath);

				const result = await runContainerExec(getState, fdArgs);
				if (result.code !== 0 && result.stdout.length === 0) {
					throw formatProcessError(`Failed to search for files under ${searchCwd}`, result);
				}

				const matched: string[] = [];
				for (const line of splitNonEmptyLines(toText(result.stdout))) {
					const hostPath = containerPathToHostPath(line.trim(), projectRoot);
					if (!hostPath) continue;
					if (!isInsideProject(hostPath, projectRoot)) continue;
					matched.push(hostPath);
					if (matched.length >= effectiveLimit) break;
				}
				return matched;
			}

			const includeRegex = globToRegex(pattern);
			const ignoreRegexes = (options.ignore ?? []).map(globToRegex);
			const scanLimit = Math.max(effectiveLimit * 25, 5000);

			const nameFilter = extractSimpleFindName(pattern);
			const findExpr = nameFilter
				? 'find "$1" -mindepth 1 -name .git -prune -o \\( -type f -o -type d \\) -name "$3" -print | head -n "$2"'
				: 'find "$1" -mindepth 1 -name .git -prune -o \\( -type f -o -type d \\) -print | head -n "$2"';

			const findArgs = ["sh", "-lc", findExpr, "sh", containerSearchPath, String(scanLimit)];
			if (nameFilter) findArgs.push(nameFilter);

			const scanResult = await runContainerExec(getState, findArgs);

			if (scanResult.code !== 0 && scanResult.stdout.length === 0) {
				throw formatProcessError(`Failed to search for files under ${searchCwd}`, scanResult);
			}

			const matched: string[] = [];
			for (const line of splitNonEmptyLines(toText(scanResult.stdout))) {
				const hostPath = containerPathToHostPath(line.trim(), projectRoot);
				if (!hostPath) continue;
				if (!isInsideProject(hostPath, projectRoot)) continue;

				const relToSearch = relative(searchCwd, hostPath).replace(/\\/g, "/");
				if (!relToSearch || relToSearch.startsWith("..") || isAbsolute(relToSearch)) continue;
				if (ignoreRegexes.some((regex) => regex.test(relToSearch))) continue;
				if (!includeRegex.test(relToSearch)) continue;

				matched.push(hostPath);
				if (matched.length >= effectiveLimit) break;
			}

			return matched;
		},
	};
}

function statusSet(ctx: ExtensionContext | undefined, key: string, value: string | undefined): void {
	if (!ctx?.ui) return;
	ctx.ui.setStatus(key, value);
}

async function getSandboxManager(): Promise<SandboxManagerLike> {
	if (!sandboxManagerPromise) {
		sandboxManagerPromise = (async () => {
			try {
				const mod = (await import("@anthropic-ai/sandbox-runtime")) as {
					SandboxManager?: SandboxManagerLike;
				};
				const manager = mod.SandboxManager;
				if (!manager || typeof manager.initialize !== "function" || typeof manager.wrapWithSandbox !== "function") {
					throw new Error("SandboxManager export not found");
				}
				return manager;
			} catch (error) {
				sandboxManagerPromise = undefined;
				throw new Error(
					`Runtime backend requires @anthropic-ai/sandbox-runtime. Install it next to the extension. (${formatError(error)})`,
				);
			}
		})();
	}
	return sandboxManagerPromise;
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("sandbox", {
		description: "Enable sandbox mode for this session",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("no-sandbox", {
		description: "Force-disable sandbox mode",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("sandbox-backend", {
		description: "Sandbox backend (container|runtime)",
		type: "string",
	});
	pi.registerFlag("sandbox-engine", {
		description: "Container engine (docker|apple)",
		type: "string",
	});
	pi.registerFlag("sandbox-image", {
		description: "Container image used for sandbox backend=container",
		type: "string",
	});
	pi.registerFlag("sandbox-network", {
		description: "Container network mode (default: none)",
		type: "string",
	});
	pi.registerFlag("sandbox-shell", {
		description: "Shell executable inside the container",
		type: "string",
	});
	pi.registerFlag("sandbox-user", {
		description: "Container user, e.g. 1000:1000",
		type: "string",
	});
	pi.registerFlag("sandbox-pull-policy", {
		description: "Image pull policy for backend=container (always|if-missing|never)",
		type: "string",
	});

	const projectRoot = process.cwd();
	const sessionOverrides: SessionOverrides = {};

	const state: SandboxState = {
		active: false,
		config: {
			enabled: DEFAULT_CONFIG.enabled,
			backend: DEFAULT_CONFIG.backend,
			container: { ...DEFAULT_CONTAINER_CONFIG },
			runtime: {
				network: {
					allowedDomains: [...DEFAULT_RUNTIME_POLICY.network.allowedDomains],
					deniedDomains: [...DEFAULT_RUNTIME_POLICY.network.deniedDomains],
				},
				filesystem: {
					denyRead: [...DEFAULT_RUNTIME_POLICY.filesystem.denyRead],
					allowWrite: [...DEFAULT_RUNTIME_POLICY.filesystem.allowWrite],
					denyWrite: [...DEFAULT_RUNTIME_POLICY.filesystem.denyWrite],
				},
			},
			hooks: { ...DEFAULT_HOOKS },
		},
	};

	const getState = () => state;

	async function runHookCommands(
		hookName: keyof Pick<HookConfig, "preInit" | "postInit" | "containerInit" | "preCommand" | "postShutdown">,
		runner: (command: string) => Promise<void>,
		ctx?: ExtensionContext,
	): Promise<void> {
		const commands = state.config.hooks[hookName];
		if (!commands || commands.length === 0) return;

		for (const command of commands) {
			try {
				await runner(command);
			} catch (error) {
				const msg = `Hook ${hookName} failed for command \`${command}\`: ${formatError(error)}`;
				if (state.config.hooks.failOnError) throw new Error(msg);
				ctx?.ui?.notify(msg, "warning");
			}
		}
	}

	async function runHostHookCommands(
		hookName: keyof Pick<HookConfig, "preInit" | "postInit" | "postShutdown">,
		ctx?: ExtensionContext,
	): Promise<void> {
		await runHookCommands(
			hookName,
			async (command) => {
				const result = await runProcess("bash", ["-lc", command], {
					cwd: projectRoot,
					timeout: state.config.hooks.timeoutSec,
				});
				if (result.code !== 0) throw formatProcessError(`Host hook ${hookName} failed`, result);
			},
			ctx,
		);
	}

	async function runContainerHookCommands(
		hookName: keyof Pick<HookConfig, "containerInit" | "preCommand">,
		containerCwd: string,
		signal?: AbortSignal,
		ctx?: ExtensionContext,
	): Promise<void> {
		await runHookCommands(
			hookName,
			async (command) => {
				const runtime = getContainerRuntimeOrThrow(getState);
				const shell = runtime.containerShell ?? runtime.config.container.shell;
				const result = await runContainerExec(getState, [shell, "-lc", command], {
					cwd: containerCwd,
					signal,
					timeout: runtime.config.hooks.timeoutSec,
				});
				if (result.code !== 0) throw formatProcessError(`Container hook ${hookName} failed`, result);
			},
			ctx,
		);
	}

	async function runRuntimePreCommandHooks(
		hostCwd: string,
		signal?: AbortSignal,
		ctx?: ExtensionContext,
	): Promise<void> {
		await runHookCommands(
			"preCommand",
			async (command) => {
				const manager = state.runtimeManager ?? (await getSandboxManager());
				state.runtimeManager = manager;
				const wrapped = await manager.wrapWithSandbox(command);
				const result = await runProcess("bash", ["-lc", wrapped], {
					cwd: hostCwd,
					signal,
					timeout: state.config.hooks.timeoutSec,
				});
				if (result.code !== 0) throw formatProcessError("Runtime preCommand hook failed", result);
			},
			ctx,
		);
	}

	function updateSandboxStatusBar(ctx?: ExtensionContext): void {
		if (!ctx?.ui) return;

		if (state.active && state.activeBackend === "container") {
			const engine = state.containerEngine ?? state.config.container.engine;
			statusSet(
				ctx,
				"sandbox",
				`📦 Sandbox: ON [backend=container engine=${engine}] (${state.config.container.image}, ${state.config.container.network})`,
			);
			statusSet(ctx, "sandbox-info", `Container: ${state.containerName} • /sandbox stop`);
			return;
		}

		if (state.active && state.activeBackend === "runtime") {
			statusSet(ctx, "sandbox", "🔒 Sandbox: ON [backend=runtime]");
			statusSet(ctx, "sandbox-info", "bash/user-bash wrapped by sandbox-runtime • /sandbox stop");
			return;
		}

		const backend = sessionOverrides.backend ?? state.config.backend;
		const engine = sessionOverrides.engine ?? state.config.container.engine;
		statusSet(
			ctx,
			"sandbox",
			`📦 Sandbox: OFF [backend=${backend}${backend === "container" ? ` engine=${engine}` : ""}]`,
		);
		statusSet(ctx, "sandbox-info", undefined);
	}

	async function containerHasCommand(command: string): Promise<boolean> {
		if (command === "rg" && state.hasRipgrep !== undefined) return state.hasRipgrep;
		if (command === "fd" && state.hasFd !== undefined) return state.hasFd;
		const probe = await runContainerExec(getState, ["sh", "-lc", 'command -v "$1" >/dev/null 2>&1', "sh", command]);
		const hasCommand = probe.code === 0;
		if (command === "rg") state.hasRipgrep = hasCommand;
		if (command === "fd") state.hasFd = hasCommand;
		return hasCommand;
	}

	async function startSandbox(ctx: ExtensionContext, forceEnable = false): Promise<void> {
		if (state.active) {
			updateSandboxStatusBar(ctx);
			return;
		}

		const config = buildEffectiveConfig(projectRoot, pi, sessionOverrides);
		if (forceEnable) config.enabled = true;
		state.config = config;
		state.lastError = undefined;
		state.hasRipgrep = undefined;
		state.hasFd = undefined;

		if (!config.enabled) {
			remapActiveTools(pi, SANDBOX_TO_HOST_TOOLS);
			updateSandboxStatusBar(ctx);
			return;
		}

		try {
			await runHostHookCommands("preInit", ctx);

			if (config.backend === "container") {
				const started = await startContainer(projectRoot, config.container, ctx);
				state.active = true;
				state.activeBackend = "container";
				state.containerName = started.containerName;
				state.containerShell = started.shell;
				state.containerEngine = config.container.engine;

				await runContainerHookCommands("containerInit", PROJECT_CONTAINER_PATH, undefined, ctx);
				remapActiveTools(pi, HOST_TO_CONTAINER_TOOLS);
				ctx.ui.notify(
					`Container sandbox active (${config.container.engine}). Built-in tools are mapped to container_* inside container ${started.containerName}`,
					"info",
				);

				const [hasRg, hasFdTool] = await Promise.all([containerHasCommand("rg"), containerHasCommand("fd")]);
				const missing: string[] = [];
				if (!hasRg) missing.push("ripgrep (rg)");
				if (!hasFdTool) missing.push("fd");
				if (missing.length > 0) {
					ctx.ui.notify(
						`Container is missing ${missing.join(" and ")} — grep/find will use slower fallbacks. Install via hooks.containerInit for better performance.`,
						"warning",
					);
				}
			} else {
				const manager = await getSandboxManager();
				await manager.initialize({
					network: config.runtime.network,
					filesystem: config.runtime.filesystem,
					ignoreViolations: config.runtime.ignoreViolations,
					enableWeakerNestedSandbox: config.runtime.enableWeakerNestedSandbox,
				});
				state.runtimeManager = manager;
				state.active = true;
				state.activeBackend = "runtime";
				remapActiveTools(pi, HOST_TO_RUNTIME_TOOLS);
				ctx.ui.notify(
					"Runtime sandbox active. bash is mapped to container_bash and wrapped by sandbox-runtime.",
					"info",
				);
			}

			await runHostHookCommands("postInit", ctx);
			updateSandboxStatusBar(ctx);
		} catch (error) {
			await stopSandbox(ctx, { skipHooks: true });
			remapActiveTools(pi, SANDBOX_TO_HOST_TOOLS);
			state.lastError = formatError(error);
			updateSandboxStatusBar(ctx);
			ctx.ui.notify(`Sandbox failed to start: ${state.lastError}`, "error");
		}
	}

	async function stopSandbox(ctx?: ExtensionContext, options?: { skipHooks?: boolean }): Promise<void> {
		const wasActive = state.active;
		const activeBackend = state.activeBackend;
		const containerName = state.containerName;
		const containerEngine = state.containerEngine;
		const manager = state.runtimeManager;

		state.active = false;
		state.activeBackend = undefined;
		state.containerName = undefined;
		state.containerShell = undefined;
		state.containerEngine = undefined;
		state.hasRipgrep = undefined;
		state.hasFd = undefined;

		if (activeBackend === "container" && containerName && containerEngine) {
			try {
				await stopContainer(containerEngine, containerName);
			} catch {
				// Ignore cleanup errors.
			}
		}

		if (activeBackend === "runtime" && manager) {
			try {
				await manager.reset();
			} catch {
				// Ignore cleanup errors.
			}
		}

		if (wasActive && !options?.skipHooks) {
			await runHostHookCommands("postShutdown", ctx);
		}

		remapActiveTools(pi, SANDBOX_TO_HOST_TOOLS);
		updateSandboxStatusBar(ctx);
	}

	const cleanupOnExit = (): void => {
		if (state.containerName && state.containerEngine) {
			stopContainerSync(state.containerEngine, state.containerName);
		}
		// Runtime manager reset is async and cannot run in the sync "exit" handler.
		// It is handled by session_shutdown -> stopSandbox -> manager.reset() instead.
	};
	process.once("exit", cleanupOnExit);

	const containerReadOps = createContainerReadOps(getState, projectRoot);
	const containerWriteOps = createContainerWriteOps(getState, projectRoot);
	const containerEditOps = createContainerEditOps(getState, projectRoot);
	const containerLsOps = createContainerLsOps(getState, projectRoot);
	const containerFindOps = createContainerFindOps(getState, projectRoot, () => containerHasCommand("fd"));

	const containerBashOps: BashOperations = {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const runtime = getContainerRuntimeOrThrow(getState);
			const safeHostCwd = resolveProjectPath(cwd, projectRoot);
			const containerCwd = hostPathToContainerPath(safeHostCwd, projectRoot);
			await runContainerHookCommands("preCommand", containerCwd, signal);
			const shell = runtime.containerShell ?? runtime.config.container.shell;
			const result = await runContainerExec(getState, [shell, "-lc", command], {
				cwd: containerCwd,
				signal,
				timeout,
				onData,
			});
			return { exitCode: result.code };
		},
	};

	const runtimeBashOps: BashOperations = {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			if (!state.active || state.activeBackend !== "runtime") {
				throw new Error("Runtime sandbox backend is not active");
			}
			const safeHostCwd = resolveProjectPath(cwd, projectRoot);
			await runRuntimePreCommandHooks(safeHostCwd, signal);
			const manager = state.runtimeManager ?? (await getSandboxManager());
			state.runtimeManager = manager;
			const wrapped = await manager.wrapWithSandbox(command);
			const result = await runProcess("bash", ["-lc", wrapped], {
				cwd: safeHostCwd,
				signal,
				timeout,
				onData,
			});
			return { exitCode: result.code };
		},
	};

	const localRead = createReadTool(projectRoot);
	const localWrite = createWriteTool(projectRoot);
	const localEdit = createEditTool(projectRoot);
	const localLs = createLsTool(projectRoot);
	const localFind = createFindTool(projectRoot);
	const localBash = createBashTool(projectRoot);
	const localGrep = createGrepTool(projectRoot);

	const containerRead = createReadTool(projectRoot, { operations: containerReadOps });
	const containerWrite = createWriteTool(projectRoot, { operations: containerWriteOps });
	const containerEdit = createEditTool(projectRoot, { operations: containerEditOps });
	const containerLs = createLsTool(projectRoot, { operations: containerLsOps });
	const containerFind = createFindTool(projectRoot, { operations: containerFindOps });
	const containerBash = createBashTool(projectRoot, { operations: containerBashOps });
	const runtimeBash = createBashTool(projectRoot, { operations: runtimeBashOps });

	async function executeContainerGrep(params: GrepToolParams, signal?: AbortSignal) {
		const searchPath = resolveProjectPath(params.path ?? ".", projectRoot);
		const searchPathInContainer = hostPathToContainerPath(searchPath, projectRoot);
		const contextValue = params.context && params.context > 0 ? Math.floor(params.context) : 0;
		const effectiveLimit = Math.max(1, Math.floor(params.limit ?? 100));
		const useRipgrep = await containerHasCommand("rg");

		let grepArgs: string[];
		if (useRipgrep) {
			grepArgs = ["rg", "--line-number", "--color=never", "--hidden"];
			if (params.ignoreCase) grepArgs.push("--ignore-case");
			if (params.literal) grepArgs.push("--fixed-strings");
			if (params.glob) grepArgs.push("--glob", params.glob);
			if (contextValue > 0) grepArgs.push("-C", String(contextValue));
			grepArgs.push("--", params.pattern, searchPathInContainer);
		} else {
			grepArgs = [
				"grep",
				"-R",
				"-n",
				"--binary-files=without-match",
				"--exclude-dir=.git",
				"--exclude-dir=node_modules",
			];
			if (params.ignoreCase) grepArgs.push("-i");
			if (params.literal) grepArgs.push("-F");
			else grepArgs.push("-E");
			if (params.glob) grepArgs.push("--include", params.glob);
			if (contextValue > 0) grepArgs.push("-C", String(contextValue));
			grepArgs.push("--", params.pattern, searchPathInContainer);
		}

		const result = await runContainerExec(getState, grepArgs, { signal });
		if (result.code === 1) {
			return textToolResult("No matches found");
		}
		if (result.code !== 0) {
			throw formatProcessError("container grep failed", result);
		}

		const allLines = splitLines(toText(result.stdout));
		if (allLines.length === 0) {
			return textToolResult("No matches found");
		}

		const limitedLines = allLines.slice(0, effectiveLimit);
		const matchLimitReached = allLines.length > effectiveLimit;
		const truncation = truncateHead(limitedLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });

		let output = truncation.content;
		const notices: string[] = [];
		const details: Record<string, unknown> = {};

		if (matchLimitReached) {
			notices.push(`${effectiveLimit} lines limit reached`);
			details.matchLimitReached = effectiveLimit;
		}
		if (truncation.truncated) {
			notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
			details.truncation = truncation;
		}
		if (notices.length > 0) {
			output += `\n\n[${notices.join(". ")}]`;
		}

		return textToolResult(output || "No matches found", Object.keys(details).length > 0 ? details : undefined);
	}

	function shouldUseContainerTools(): boolean {
		return state.active && state.activeBackend === "container";
	}

	function shouldUseRuntimeBash(): boolean {
		return state.active && state.activeBackend === "runtime";
	}

	// Sandbox-prefixed tools used via active-tool remapping.
	pi.registerTool({
		...containerRead,
		name: "container_read",
		label: "container_read",
		description: "Read inside the container sandbox when backend=container. Falls back to host read otherwise.",
		async execute(id, params, signal, onUpdate) {
			if (shouldUseContainerTools()) return containerRead.execute(id, params, signal, onUpdate);
			return localRead.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...containerWrite,
		name: "container_write",
		label: "container_write",
		description: "Write inside the container sandbox when backend=container. Falls back to host write otherwise.",
		async execute(id, params, signal, onUpdate) {
			if (shouldUseContainerTools()) return containerWrite.execute(id, params, signal, onUpdate);
			return localWrite.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...containerEdit,
		name: "container_edit",
		label: "container_edit",
		description: "Edit inside the container sandbox when backend=container. Falls back to host edit otherwise.",
		async execute(id, params, signal, onUpdate) {
			if (shouldUseContainerTools()) return containerEdit.execute(id, params, signal, onUpdate);
			return localEdit.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...containerLs,
		name: "container_ls",
		label: "container_ls",
		description: "List paths inside the container sandbox when backend=container. Falls back to host ls otherwise.",
		async execute(id, params, signal, onUpdate) {
			if (shouldUseContainerTools()) return containerLs.execute(id, params, signal, onUpdate);
			return localLs.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...containerFind,
		name: "container_find",
		label: "container_find",
		description: "Find files inside the container sandbox when backend=container. Falls back to host find otherwise.",
		async execute(id, params, signal, onUpdate) {
			if (shouldUseContainerTools()) return containerFind.execute(id, params, signal, onUpdate);
			return localFind.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...containerBash,
		name: "container_bash",
		label: "container_bash",
		description:
			"Execute bash in the selected sandbox backend (container/runtime). Falls back to host bash when sandbox is off.",
		async execute(id, params, signal, onUpdate) {
			if (shouldUseContainerTools()) return containerBash.execute(id, params, signal, onUpdate);
			if (shouldUseRuntimeBash()) return runtimeBash.execute(id, params, signal, onUpdate);
			return localBash.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		name: "container_grep",
		label: "container_grep",
		description:
			"Search file contents inside the container sandbox when backend=container. Falls back to host grep otherwise.",
		parameters: grepSchema,
		async execute(id, params, signal, onUpdate) {
			if (shouldUseContainerTools()) return executeContainerGrep(params, signal);
			return localGrep.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await startSandbox(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await stopSandbox(ctx);
	});

	pi.on("user_bash", async () => {
		if (shouldUseContainerTools()) return { operations: containerBashOps };
		if (shouldUseRuntimeBash()) return { operations: runtimeBashOps };
		return;
	});

	pi.on("tool_call", async (event) => {
		if (state.active && state.activeBackend === "container") {
			if (["bash", "read", "write", "edit", "grep", "find", "ls"].includes(event.toolName)) {
				return { block: true, reason: "Container sandbox is active. Use container_* tools." };
			}
		}
		if (state.active && state.activeBackend === "runtime" && event.toolName === "bash") {
			return { block: true, reason: "Runtime sandbox is active. Use container_bash." };
		}
		return;
	});

	pi.on("before_agent_start", async (event) => {
		if (state.active && state.activeBackend === "container" && state.containerName) {
			const cwdLine = `Current working directory: ${projectRoot}`;
			const replacement = `Current working directory: ${PROJECT_CONTAINER_PATH} (inside ${state.containerEngine} sandbox container)`;
			const updatedPrompt = event.systemPrompt.includes(cwdLine)
				? event.systemPrompt.replace(cwdLine, replacement)
				: event.systemPrompt;

			const note =
				"\n\nContainer sandbox mode is active. Built-in file/search/bash tools execute inside the sandbox container. " +
				`Container backend: ${state.containerEngine}. Project is mounted at ${PROJECT_CONTAINER_PATH}.`;
			return { systemPrompt: updatedPrompt + note };
		}

		if (state.active && state.activeBackend === "runtime") {
			const note =
				"\n\nRuntime sandbox mode is active. bash and user-bash commands are wrapped with sandbox-runtime restrictions.";
			return { systemPrompt: event.systemPrompt + note };
		}

		return;
	});

	pi.registerCommand("sandbox-shell", {
		description: "Open an interactive shell inside the running container sandbox",
		handler: async (_args, ctx) => {
			if (!state.active || state.activeBackend !== "container") {
				sessionOverrides.backend = "container";
				if (state.active) await stopSandbox(ctx);
				await startSandbox(ctx, true);
			}

			if (!state.active || state.activeBackend !== "container" || !state.containerName || !state.containerEngine) {
				ctx.ui.notify("Container sandbox is not running", "error");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive shell requires TUI mode", "warning");
				return;
			}

			const shell = state.containerShell ?? state.config.container.shell;
			const command = getContainerBinary(state.containerEngine);
			const args = buildContainerExecArgs(state.containerEngine, state.containerName, [shell], {
				cwd: PROJECT_CONTAINER_PATH,
				interactive: true,
				tty: true,
			});

			const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
				tui.stop();
				process.stdout.write("\x1b[2J\x1b[H");
				const result = spawnSync(command, args, { stdio: "inherit" });
				tui.start();
				tui.requestRender(true);
				done(result.status);
				return { render: () => [], invalidate: () => {} };
			});

			if ((exitCode ?? 0) === 0) {
				ctx.ui.notify("Interactive sandbox shell closed", "info");
			} else {
				ctx.ui.notify(`Interactive sandbox shell exited with code ${exitCode}`, "warning");
			}
		},
	});

	pi.registerCommand("sandbox", {
		description: "Manage sandbox (status|start|stop|restart|toggle|backend|engine)",
		handler: async (args, ctx) => {
			const tokens = (args ?? "")
				.trim()
				.split(/\s+/)
				.filter((token) => token.length > 0);
			const action = (tokens[0] ?? "status").toLowerCase();

			switch (action) {
				case "start": {
					if (state.active) {
						ctx.ui.notify("Sandbox already running", "info");
						return;
					}
					await startSandbox(ctx, true);
					return;
				}
				case "stop": {
					const wasRunning = state.active;
					await stopSandbox(ctx);
					ctx.ui.notify(wasRunning ? "Sandbox stopped" : "Sandbox was not running", "info");
					return;
				}
				case "restart": {
					await stopSandbox(ctx);
					await startSandbox(ctx, true);
					return;
				}
				case "toggle": {
					if (state.active) {
						await stopSandbox(ctx);
						ctx.ui.notify("Sandbox disabled for this session", "info");
					} else {
						await startSandbox(ctx, true);
					}
					return;
				}
				case "backend": {
					const requested = parseBackend(tokens[1]);
					if (!requested) {
						const current = state.activeBackend ?? sessionOverrides.backend ?? state.config.backend;
						ctx.ui.notify(`Sandbox backend: ${current}`, "info");
						return;
					}

					sessionOverrides.backend = requested;
					if (state.active) {
						await stopSandbox(ctx);
						await startSandbox(ctx, true);
					}
					updateSandboxStatusBar(ctx);
					ctx.ui.notify(`Sandbox backend set to ${requested} for this session`, "info");
					return;
				}
				case "engine": {
					const requested = parseEngine(tokens[1]);
					if (!requested) {
						const current = state.containerEngine ?? sessionOverrides.engine ?? state.config.container.engine;
						ctx.ui.notify(`Sandbox engine: ${current}`, "info");
						return;
					}

					sessionOverrides.engine = requested;
					if (state.active && state.activeBackend === "container") {
						await stopSandbox(ctx);
						await startSandbox(ctx, true);
					}
					updateSandboxStatusBar(ctx);
					ctx.ui.notify(`Sandbox engine set to ${requested} for this session`, "info");
					return;
				}
				default: {
					updateSandboxStatusBar(ctx);
					if (state.active && state.activeBackend === "container") {
						ctx.ui.notify(
							[
								"Sandbox is running",
								"Backend: container",
								`Engine: ${state.containerEngine}`,
								`Container: ${state.containerName}`,
								`Image: ${state.config.container.image}`,
								`Network: ${state.config.container.network}`,
								`Shell: ${state.containerShell ?? state.config.container.shell}`,
								`Project mount: ${projectRoot} -> ${PROJECT_CONTAINER_PATH}`,
								`Pull policy: ${state.config.container.pullPolicy}`,
								`Hooks preCommand: ${state.config.hooks.preCommand.length}`,
								"Tools remapped: bash/read/write/edit/grep/find/ls -> container_*",
								`Active tools: ${pi.getActiveTools().join(", ")}`,
								"Interactive shell command: /sandbox-shell",
								"Switch backend: /sandbox backend runtime",
								"Switch engine: /sandbox engine docker|apple",
							].join("\n"),
							"info",
						);
						return;
					}

					if (state.active && state.activeBackend === "runtime") {
						ctx.ui.notify(
							[
								"Sandbox is running",
								"Backend: runtime",
								`Allowed domains: ${state.config.runtime.network.allowedDomains.length}`,
								`Allowed write paths: ${state.config.runtime.filesystem.allowWrite.length}`,
								`Hooks preCommand: ${state.config.hooks.preCommand.length}`,
								"Tools remapped: bash -> container_bash",
								`Active tools: ${pi.getActiveTools().join(", ")}`,
								"Switch backend: /sandbox backend container",
							].join("\n"),
							"info",
						);
						return;
					}

					const configured = buildEffectiveConfig(projectRoot, pi, sessionOverrides);
					const lines = [
						"Sandbox is not running",
						`Configured enabled: ${configured.enabled}`,
						`Backend: ${configured.backend}`,
						`Engine: ${configured.container.engine}`,
						`Image: ${configured.container.image}`,
						`Network: ${configured.container.network}`,
						`Runtime allowed domains: ${configured.runtime.network.allowedDomains.length}`,
						"Use /sandbox start (or /sandbox toggle) to enable it.",
					];
					if (state.lastError) lines.push(`Last error: ${state.lastError}`);
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
			}
		},
	});
}
