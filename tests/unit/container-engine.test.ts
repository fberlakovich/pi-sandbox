import assert from "node:assert/strict";
import test from "node:test";

import {
	buildContainerExecArgs,
	buildContainerImagePullArgs,
	buildContainerRemoveArgs,
	buildContainerRunArgs,
	defaultUserSpec,
	getContainerBinary,
	PROJECT_CONTAINER_PATH,
	parseBackend,
	parseEngine,
	parsePullPolicy,
} from "../../container-engine";

test("parse helpers accept only supported values", () => {
	assert.equal(parseBackend("container"), "container");
	assert.equal(parseBackend("runtime"), "runtime");
	assert.equal(parseBackend("podman"), undefined);

	assert.equal(parseEngine("docker"), "docker");
	assert.equal(parseEngine("apple"), "apple");
	assert.equal(parseEngine("podman"), undefined);

	assert.equal(parsePullPolicy("always"), "always");
	assert.equal(parsePullPolicy("if-missing"), "if-missing");
	assert.equal(parsePullPolicy("never"), "never");
	assert.equal(parsePullPolicy("sometimes"), undefined);
});

test("getContainerBinary maps engine to binary", () => {
	assert.equal(getContainerBinary("docker"), "docker");
	assert.equal(getContainerBinary("apple"), "container");
});

test("buildContainerExecArgs includes tty/input/cwd flags", () => {
	const args = buildContainerExecArgs("docker", "c1", ["bash", "-lc", "pwd"], {
		cwd: "/workspace/main",
		interactive: true,
		tty: true,
	});
	assert.deepEqual(args, ["exec", "-i", "-t", "-w", "/workspace/main", "c1", "bash", "-lc", "pwd"]);
});

test("buildContainerRemoveArgs and pull args differ by engine", () => {
	assert.deepEqual(buildContainerRemoveArgs("docker", "abc"), ["rm", "-f", "abc"]);
	assert.deepEqual(buildContainerRemoveArgs("apple", "abc"), ["delete", "--force", "abc"]);

	assert.deepEqual(buildContainerImagePullArgs("docker", "img:latest"), ["pull", "img:latest"]);
	assert.deepEqual(buildContainerImagePullArgs("apple", "img:latest"), [
		"image",
		"pull",
		"--progress",
		"ansi",
		"img:latest",
	]);
});

test("defaultUserSpec handles missing uid/gid accessors", () => {
	assert.equal(defaultUserSpec({}), undefined);
	assert.equal(
		defaultUserSpec({
			getuid: () => 501,
			getgid: () => 20,
		}),
		"501:20",
	);
});

test("buildContainerRunArgs for docker includes hardening and rw mount", () => {
	const args = buildContainerRunArgs(
		"/tmp/project",
		{
			engine: "docker",
			image: "ubuntu:24.04",
			network: "none",
			shell: "bash",
			runArgs: ["--memory", "4g"],
			env: { CI: "1" },
			user: "1000:1000",
		},
		"box-1",
	);

	assert.ok(args.includes("--rm"));
	assert.ok(args.includes("--cap-drop=ALL"));
	assert.ok(args.includes("--security-opt"));
	assert.ok(args.includes("no-new-privileges"));
	assert.ok(args.includes("--pids-limit"));
	assert.ok(args.includes("1024"));
	assert.ok(args.includes("-e"));
	assert.ok(args.includes("CI=1"));
	assert.ok(args.includes("--user"));
	assert.ok(args.includes("1000:1000"));
	assert.ok(args.includes("-v"));
	assert.ok(args.includes(`/tmp/project:${PROJECT_CONTAINER_PATH}:rw`));
});

test("buildContainerRunArgs for apple uses --volume and --remove", () => {
	const args = buildContainerRunArgs(
		"/tmp/project",
		{
			engine: "apple",
			image: "ubuntu:24.04",
			network: "none",
			shell: "bash",
			runArgs: [],
			env: { CI: "1" },
			user: "1000:1000",
		},
		"box-2",
	);

	assert.ok(args.includes("--remove"));
	assert.ok(args.includes("--volume"));
	assert.ok(args.includes(`/tmp/project:${PROJECT_CONTAINER_PATH}`));
	assert.ok(args.includes("--env"));
	assert.ok(args.includes("CI=1"));
	assert.ok(args.includes("--user"));
	assert.ok(args.includes("1000:1000"));
});
