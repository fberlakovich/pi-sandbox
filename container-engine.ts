export type SandboxBackend = "container" | "runtime";
export type ContainerEngine = "docker" | "apple";
export type PullPolicy = "always" | "if-missing" | "never";

export const PROJECT_CONTAINER_PATH = "/workspace/main";

export interface ContainerExecArgOptions {
	cwd?: string;
	input?: string | Buffer;
	interactive?: boolean;
	tty?: boolean;
}

export interface ContainerRunConfig {
	engine: ContainerEngine;
	image: string;
	network: string;
	shell: string;
	runArgs: string[];
	env: Record<string, string>;
	user?: string;
}

export function parseBackend(value: unknown): SandboxBackend | undefined {
	if (value === "container" || value === "runtime") return value;
	return undefined;
}

export function parseEngine(value: unknown): ContainerEngine | undefined {
	if (value === "docker" || value === "apple") return value;
	return undefined;
}

export function parsePullPolicy(value: unknown): PullPolicy | undefined {
	if (value === "always" || value === "if-missing" || value === "never") return value;
	return undefined;
}

export function getContainerBinary(engine: ContainerEngine): string {
	return engine === "apple" ? "container" : "docker";
}

export function defaultUserSpec(
	processLike: { getuid?: (() => number) | undefined; getgid?: (() => number) | undefined } = process,
): string | undefined {
	if (typeof processLike.getuid !== "function" || typeof processLike.getgid !== "function") return undefined;
	return `${processLike.getuid()}:${processLike.getgid()}`;
}

export function buildContainerExecArgs(
	_engine: ContainerEngine,
	containerName: string,
	args: string[],
	options: ContainerExecArgOptions,
): string[] {
	const execArgs = ["exec"];
	if (options.interactive || options.input !== undefined) execArgs.push("-i");
	if (options.tty) execArgs.push("-t");
	if (options.cwd) execArgs.push("-w", options.cwd);
	execArgs.push(containerName, ...args);
	return execArgs;
}

export function buildContainerRemoveArgs(engine: ContainerEngine, containerName: string): string[] {
	if (engine === "apple") return ["delete", "--force", containerName];
	return ["rm", "-f", containerName];
}

export function buildContainerImageInspectArgs(_engine: ContainerEngine, image: string): string[] {
	return ["image", "inspect", image];
}

export function buildContainerImagePullArgs(engine: ContainerEngine, image: string): string[] {
	if (engine === "apple") return ["image", "pull", "--progress", "ansi", image];
	return ["pull", image];
}

export function buildContainerRunArgs(
	projectRoot: string,
	config: ContainerRunConfig,
	containerName: string,
): string[] {
	const userSpec = config.user ?? defaultUserSpec();

	if (config.engine === "apple") {
		// Apple Containerization Framework runs containers in lightweight VMs,
		// providing hardware-level isolation. Docker-style capability/seccomp flags
		// (--cap-drop, --security-opt, --pids-limit, --init) have no equivalents
		// and are unnecessary — the VM boundary is stronger than namespace isolation.
		const args = [
			"run",
			"-d",
			"--remove",
			"--name",
			containerName,
			"--workdir",
			PROJECT_CONTAINER_PATH,
			"--volume",
			`${projectRoot}:${PROJECT_CONTAINER_PATH}`,
			"--network",
			config.network,
		];

		if (userSpec) args.push("--user", userSpec);
		for (const [key, value] of Object.entries(config.env)) {
			args.push("--env", `${key}=${value}`);
		}
		args.push(...config.runArgs);
		args.push(config.image, "sh", "-lc", "while true; do sleep 3600; done");
		return args;
	}

	const args = [
		"run",
		"-d",
		"--rm",
		"--name",
		containerName,
		"--workdir",
		PROJECT_CONTAINER_PATH,
		"-v",
		`${projectRoot}:${PROJECT_CONTAINER_PATH}:rw`,
		"--network",
		config.network,
		"--init",
		"--cap-drop=ALL",
		"--security-opt",
		"no-new-privileges",
		"--pids-limit",
		"1024",
	];

	if (userSpec) args.push("--user", userSpec);
	for (const [key, value] of Object.entries(config.env)) {
		args.push("-e", `${key}=${value}`);
	}
	args.push(...config.runArgs);
	args.push(config.image, "sh", "-lc", "while true; do sleep 3600; done");
	return args;
}
