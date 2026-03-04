import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type ContainerEngine,
	type PullPolicy,
	parseBackend,
	parseEngine,
	parsePullPolicy,
	type SandboxBackend,
} from "./container-engine";

export interface RuntimePolicyConfigInput {
	network?: {
		allowedDomains?: string[];
		deniedDomains?: string[];
	};
	filesystem?: {
		denyRead?: string[];
		allowWrite?: string[];
		denyWrite?: string[];
	};
	ignoreViolations?: Record<string, string[]>;
	enableWeakerNestedSandbox?: boolean;
}

export interface RuntimePolicyConfig {
	network: {
		allowedDomains: string[];
		deniedDomains: string[];
	};
	filesystem: {
		denyRead: string[];
		allowWrite: string[];
		denyWrite: string[];
	};
	ignoreViolations?: Record<string, string[]>;
	enableWeakerNestedSandbox?: boolean;
}

export interface HookConfigInput {
	preInit?: string[];
	postInit?: string[];
	containerInit?: string[];
	preCommand?: string[];
	postShutdown?: string[];
	failOnError?: boolean;
	timeoutSec?: number;
}

export interface HookConfig {
	preInit: string[];
	postInit: string[];
	containerInit: string[];
	preCommand: string[];
	postShutdown: string[];
	failOnError: boolean;
	timeoutSec: number;
}

export interface ContainerSandboxConfigInput {
	engine?: ContainerEngine;
	image?: string;
	network?: string;
	shell?: string;
	runArgs?: string[];
	env?: Record<string, string>;
	user?: string;
	pullPolicy?: PullPolicy;
}

export interface ContainerSandboxConfig {
	engine: ContainerEngine;
	image: string;
	network: string;
	shell: string;
	runArgs: string[];
	env: Record<string, string>;
	user?: string;
	pullPolicy: PullPolicy;
}

export interface SandboxConfigInput {
	enabled?: boolean;
	backend?: SandboxBackend;
	container?: ContainerSandboxConfigInput;
	runtime?: RuntimePolicyConfigInput;
	hooks?: HookConfigInput;

	// Backwards-compatible top-level container keys
	engine?: ContainerEngine;
	image?: string;
	network?: string;
	shell?: string;
	runArgs?: string[];
	env?: Record<string, string>;
	user?: string;
	pullPolicy?: PullPolicy;
}

export interface SandboxConfig {
	enabled: boolean;
	backend: SandboxBackend;
	container: ContainerSandboxConfig;
	runtime: RuntimePolicyConfig;
	hooks: HookConfig;
}

export interface SandboxManagerLike {
	initialize(config: Record<string, unknown>): Promise<void>;
	wrapWithSandbox(command: string): Promise<string>;
	reset(): Promise<void>;
}

export interface SandboxState {
	active: boolean;
	activeBackend?: SandboxBackend;
	containerName?: string;
	containerShell?: string;
	containerEngine?: ContainerEngine;
	config: SandboxConfig;
	lastError?: string;
	hasRipgrep?: boolean;
	hasFd?: boolean;
	runtimeManager?: SandboxManagerLike;
}

export interface SessionOverrides {
	backend?: SandboxBackend;
	engine?: ContainerEngine;
}

export const DEFAULT_CONTAINER_CONFIG: ContainerSandboxConfig = {
	engine: "docker",
	image: "ubuntu:24.04",
	network: "none",
	shell: "bash",
	runArgs: [],
	env: {},
	pullPolicy: "if-missing",
};

export const DEFAULT_RUNTIME_POLICY: RuntimePolicyConfig = {
	network: {
		allowedDomains: [
			"npmjs.org",
			"*.npmjs.org",
			"registry.npmjs.org",
			"registry.yarnpkg.com",
			"pypi.org",
			"*.pypi.org",
			"github.com",
			"*.github.com",
			"api.github.com",
			"raw.githubusercontent.com",
		],
		deniedDomains: [],
	},
	filesystem: {
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
		allowWrite: [".", "/tmp"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key"],
	},
};

export const DEFAULT_HOOKS: HookConfig = {
	preInit: [],
	postInit: [],
	containerInit: [],
	preCommand: [],
	postShutdown: [],
	failOnError: true,
	timeoutSec: 120,
};

export const DEFAULT_CONFIG: SandboxConfig = {
	enabled: false,
	backend: "container",
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
};

function asObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((entry): entry is string => typeof entry === "string");
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
	const obj = asObject(value);
	const out: Record<string, string> = {};
	for (const [key, val] of Object.entries(obj)) {
		if (typeof val === "string") out[key] = val;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function asNestedStringArrayRecord(value: unknown): Record<string, string[]> | undefined {
	const obj = asObject(value);
	const out: Record<string, string[]> = {};
	for (const [key, val] of Object.entries(obj)) {
		const arr = asStringArray(val);
		if (arr && arr.length > 0) out[key] = arr;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeContainerConfig(input: unknown): ContainerSandboxConfigInput {
	const obj = asObject(input);
	return {
		engine: parseEngine(obj.engine),
		image: typeof obj.image === "string" ? obj.image : undefined,
		network: typeof obj.network === "string" ? obj.network : undefined,
		shell: typeof obj.shell === "string" ? obj.shell : undefined,
		runArgs: asStringArray(obj.runArgs),
		env: asStringRecord(obj.env),
		user: typeof obj.user === "string" ? obj.user : undefined,
		pullPolicy: parsePullPolicy(obj.pullPolicy),
	};
}

function sanitizeRuntimePolicy(input: unknown): RuntimePolicyConfigInput {
	const obj = asObject(input);
	const network = asObject(obj.network);
	const filesystem = asObject(obj.filesystem);
	return {
		network: {
			allowedDomains: asStringArray(network.allowedDomains),
			deniedDomains: asStringArray(network.deniedDomains),
		},
		filesystem: {
			denyRead: asStringArray(filesystem.denyRead),
			allowWrite: asStringArray(filesystem.allowWrite),
			denyWrite: asStringArray(filesystem.denyWrite),
		},
		ignoreViolations: asNestedStringArrayRecord(obj.ignoreViolations),
		enableWeakerNestedSandbox:
			typeof obj.enableWeakerNestedSandbox === "boolean" ? obj.enableWeakerNestedSandbox : undefined,
	};
}

function sanitizeHooks(input: unknown): HookConfigInput {
	const obj = asObject(input);
	return {
		preInit: asStringArray(obj.preInit),
		postInit: asStringArray(obj.postInit),
		containerInit: asStringArray(obj.containerInit),
		preCommand: asStringArray(obj.preCommand),
		postShutdown: asStringArray(obj.postShutdown),
		failOnError: typeof obj.failOnError === "boolean" ? obj.failOnError : undefined,
		timeoutSec: typeof obj.timeoutSec === "number" && Number.isFinite(obj.timeoutSec) ? obj.timeoutSec : undefined,
	};
}

function sanitizeConfig(input: unknown): SandboxConfigInput {
	const obj = asObject(input);

	const legacyContainerConfig: ContainerSandboxConfigInput = {
		engine: parseEngine(obj.engine),
		image: typeof obj.image === "string" ? obj.image : undefined,
		network: typeof obj.network === "string" ? obj.network : undefined,
		shell: typeof obj.shell === "string" ? obj.shell : undefined,
		runArgs: asStringArray(obj.runArgs),
		env: asStringRecord(obj.env),
		user: typeof obj.user === "string" ? obj.user : undefined,
		pullPolicy: parsePullPolicy(obj.pullPolicy),
	};

	return {
		enabled: typeof obj.enabled === "boolean" ? obj.enabled : undefined,
		backend: parseBackend(obj.backend),
		container: mergeContainerConfig(legacyContainerConfig, sanitizeContainerConfig(obj.container)),
		runtime: sanitizeRuntimePolicy(obj.runtime),
		hooks: sanitizeHooks(obj.hooks),
	};
}

function mergeContainerConfig(
	base: ContainerSandboxConfigInput,
	overrides: ContainerSandboxConfigInput,
): ContainerSandboxConfigInput {
	return {
		engine: overrides.engine ?? base.engine,
		image: overrides.image ?? base.image,
		network: overrides.network ?? base.network,
		shell: overrides.shell ?? base.shell,
		runArgs: overrides.runArgs ?? base.runArgs,
		env: { ...(base.env ?? {}), ...(overrides.env ?? {}) },
		user: overrides.user ?? base.user,
		pullPolicy: overrides.pullPolicy ?? base.pullPolicy,
	};
}

function mergeRuntimePolicy(
	base: RuntimePolicyConfigInput,
	overrides: RuntimePolicyConfigInput,
): RuntimePolicyConfigInput {
	return {
		network: {
			allowedDomains: overrides.network?.allowedDomains ?? base.network?.allowedDomains,
			deniedDomains: overrides.network?.deniedDomains ?? base.network?.deniedDomains,
		},
		filesystem: {
			denyRead: overrides.filesystem?.denyRead ?? base.filesystem?.denyRead,
			allowWrite: overrides.filesystem?.allowWrite ?? base.filesystem?.allowWrite,
			denyWrite: overrides.filesystem?.denyWrite ?? base.filesystem?.denyWrite,
		},
		ignoreViolations: overrides.ignoreViolations ?? base.ignoreViolations,
		enableWeakerNestedSandbox: overrides.enableWeakerNestedSandbox ?? base.enableWeakerNestedSandbox,
	};
}

function mergeHooks(base: HookConfigInput, overrides: HookConfigInput): HookConfigInput {
	return {
		preInit: overrides.preInit ?? base.preInit,
		postInit: overrides.postInit ?? base.postInit,
		containerInit: overrides.containerInit ?? base.containerInit,
		preCommand: overrides.preCommand ?? base.preCommand,
		postShutdown: overrides.postShutdown ?? base.postShutdown,
		failOnError: overrides.failOnError ?? base.failOnError,
		timeoutSec: overrides.timeoutSec ?? base.timeoutSec,
	};
}

function mergeConfig(base: SandboxConfigInput, overrides: SandboxConfigInput): SandboxConfigInput {
	return {
		enabled: overrides.enabled ?? base.enabled,
		backend: overrides.backend ?? base.backend,
		container: mergeContainerConfig(base.container ?? {}, overrides.container ?? {}),
		runtime: mergeRuntimePolicy(base.runtime ?? {}, overrides.runtime ?? {}),
		hooks: mergeHooks(base.hooks ?? {}, overrides.hooks ?? {}),
	};
}

function readConfigFile(path: string): SandboxConfigInput {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return sanitizeConfig(parsed);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error(`[pi-sandbox] Failed to parse ${path}: ${msg}`);
		return {};
	}
}

function loadConfig(projectRoot: string): SandboxConfigInput {
	const globalSandboxPath = join(homedir(), ".pi", "agent", "sandbox.json");
	const globalDockerSandboxPath = join(homedir(), ".pi", "agent", "docker-sandbox.json");
	const projectSandboxPath = join(projectRoot, ".pi", "sandbox.json");
	const projectDockerSandboxPath = join(projectRoot, ".pi", "docker-sandbox.json");

	let merged: SandboxConfigInput = {};
	for (const path of [globalSandboxPath, globalDockerSandboxPath, projectSandboxPath, projectDockerSandboxPath]) {
		merged = mergeConfig(merged, readConfigFile(path));
	}
	return merged;
}

function getStringFlag(pi: ExtensionAPI, name: string): string | undefined {
	const value = pi.getFlag(name) as string | undefined;
	if (value !== undefined && value !== "") return value;
	return undefined;
}

function getBooleanFlag(pi: ExtensionAPI, name: string): boolean {
	return Boolean(pi.getFlag(name));
}

export function buildEffectiveConfig(
	projectRoot: string,
	pi: ExtensionAPI,
	sessionOverrides: SessionOverrides,
): SandboxConfig {
	const fileConfig = loadConfig(projectRoot);
	const cliOverrides: SandboxConfigInput = {};
	const cliContainer: ContainerSandboxConfigInput = {};

	const image = getStringFlag(pi, "sandbox-image");
	const network = getStringFlag(pi, "sandbox-network");
	const shell = getStringFlag(pi, "sandbox-shell");
	const user = getStringFlag(pi, "sandbox-user");
	const backend = parseBackend(getStringFlag(pi, "sandbox-backend"));
	const engine = parseEngine(getStringFlag(pi, "sandbox-engine"));
	const pullPolicy = parsePullPolicy(getStringFlag(pi, "sandbox-pull-policy"));

	if (image) cliContainer.image = image;
	if (network) cliContainer.network = network;
	if (shell) cliContainer.shell = shell;
	if (user) cliContainer.user = user;
	if (engine) cliContainer.engine = engine;
	if (pullPolicy) cliContainer.pullPolicy = pullPolicy;
	if (Object.keys(cliContainer).length > 0) cliOverrides.container = cliContainer;
	if (backend) cliOverrides.backend = backend;

	let merged = mergeConfig(fileConfig, cliOverrides);

	if (sessionOverrides.backend) {
		merged = mergeConfig(merged, { backend: sessionOverrides.backend });
	}
	if (sessionOverrides.engine) {
		merged = mergeConfig(merged, { container: { engine: sessionOverrides.engine } });
	}

	const forceEnable = getBooleanFlag(pi, "sandbox");
	const forceDisable = getBooleanFlag(pi, "no-sandbox");
	const enabledFromConfig = merged.enabled ?? DEFAULT_CONFIG.enabled;

	const hooksTimeout = Math.max(1, Math.floor(merged.hooks?.timeoutSec ?? DEFAULT_HOOKS.timeoutSec));

	return {
		enabled: forceDisable ? false : forceEnable ? true : enabledFromConfig,
		backend: merged.backend ?? DEFAULT_CONFIG.backend,
		container: {
			engine: merged.container?.engine ?? DEFAULT_CONTAINER_CONFIG.engine,
			image: merged.container?.image ?? DEFAULT_CONTAINER_CONFIG.image,
			network: merged.container?.network ?? DEFAULT_CONTAINER_CONFIG.network,
			shell: merged.container?.shell ?? DEFAULT_CONTAINER_CONFIG.shell,
			runArgs: merged.container?.runArgs ?? DEFAULT_CONTAINER_CONFIG.runArgs,
			env: merged.container?.env ?? DEFAULT_CONTAINER_CONFIG.env,
			user: merged.container?.user,
			pullPolicy: merged.container?.pullPolicy ?? DEFAULT_CONTAINER_CONFIG.pullPolicy,
		},
		runtime: {
			network: {
				allowedDomains: merged.runtime?.network?.allowedDomains ?? DEFAULT_RUNTIME_POLICY.network.allowedDomains,
				deniedDomains: merged.runtime?.network?.deniedDomains ?? DEFAULT_RUNTIME_POLICY.network.deniedDomains,
			},
			filesystem: {
				denyRead: merged.runtime?.filesystem?.denyRead ?? DEFAULT_RUNTIME_POLICY.filesystem.denyRead,
				allowWrite: merged.runtime?.filesystem?.allowWrite ?? DEFAULT_RUNTIME_POLICY.filesystem.allowWrite,
				denyWrite: merged.runtime?.filesystem?.denyWrite ?? DEFAULT_RUNTIME_POLICY.filesystem.denyWrite,
			},
			ignoreViolations: merged.runtime?.ignoreViolations,
			enableWeakerNestedSandbox: merged.runtime?.enableWeakerNestedSandbox,
		},
		hooks: {
			preInit: merged.hooks?.preInit ?? DEFAULT_HOOKS.preInit,
			postInit: merged.hooks?.postInit ?? DEFAULT_HOOKS.postInit,
			containerInit: merged.hooks?.containerInit ?? DEFAULT_HOOKS.containerInit,
			preCommand: merged.hooks?.preCommand ?? DEFAULT_HOOKS.preCommand,
			postShutdown: merged.hooks?.postShutdown ?? DEFAULT_HOOKS.postShutdown,
			failOnError: merged.hooks?.failOnError ?? DEFAULT_HOOKS.failOnError,
			timeoutSec: hooksTimeout,
		},
	};
}
