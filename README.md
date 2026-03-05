# pi-sandbox extension

`pi-sandbox` is a dual-backend sandbox extension for pi:

- **container backend** (default): tools run inside a long-lived container
- **runtime backend**: `bash` / `user-bash` are wrapped with `@anthropic-ai/sandbox-runtime`

Container backend supports:

- `docker`
- `apple` (Apple Containerization Framework CLI: `container`)

## Features

- In-session backend switching (`/sandbox backend ...`)
- In-session engine switching (`/sandbox engine ...`)
- Tool remapping to sandboxed variants (`container_*`)
- Hook support (`preInit`, `postInit`, `containerInit`, `preCommand`, `postShutdown`)
- Pull policy support (`always`, `if-missing`, `never`)
- Backend/engine visibility in status output

## Container lifecycle and persistence

### When the container starts

Container backend starts when sandbox gets enabled for the session:

- automatically on `session_start` if config has `enabled: true`, or
- manually via `/sandbox start` or `/sandbox toggle`, or
- implicitly via `/sandbox-shell` (it will start container backend if needed).

### When the container stops

Container backend is stopped when:

- `/sandbox stop` is executed,
- `/sandbox restart` or backend/engine switch triggers a stop/start cycle,
- `/sandbox toggle` disables sandbox,
- `session_shutdown` fires, or
- process exits (best-effort cleanup).

### Does container data persist?

Containers are created with auto-remove semantics (`--rm` for Docker, `--remove` for Apple), so **container filesystem state is ephemeral**.

The container backend bind-mounts the pi session's working directory (project root) into the container at `/workspace/main`. This is the only shared path between host and container.

Persistence behavior:

- **Changes under `/workspace/main` persist** because they write through to host files via the bind mount.
- **Changes outside the mount do not persist** (installed packages, system files, and anything else in the container layer are removed when the container is deleted).

If you need reproducible setup each run, use `hooks.containerInit` to install tools/packages at startup.

### Runtime backend persistence

Runtime backend does not create a container. It wraps host shell commands with runtime policies, so changes behave like normal host writes.

## Defaults

| Setting | Default |
|---------|---------|
| `backend` | `container` |
| `container.engine` | `docker` |
| `container.image` | `ubuntu:24.04` |
| `container.network` | `none` |
| `container.shell` | `bash` (auto-detected: tries `bash`, `sh`, `cat`) |
| `container.pullPolicy` | `if-missing` |
| `hooks.failOnError` | `true` |
| `hooks.timeoutSec` | `120` |

## Install extension

From npm:

```bash
pi install pi-sandbox
```

From a git repository:

```bash
pi install github.com/fberlakovich/pi-sandbox
```

From a local clone (project-local with `-l`):

```bash
pi install ./path/to/pi-sandbox -l
```

## Apple container engine setup

If you want to use `/sandbox engine apple`:

```bash
brew install container
container system start --enable-kernel-install
container system status
```

Apple Containerization Framework runs containers in lightweight VMs, providing hardware-level isolation that is stronger than Docker's namespace-based isolation. Docker-style security flags (`--cap-drop`, `--security-opt`, `--pids-limit`) have no equivalents and are unnecessary with the Apple engine.

If your image exists only in Docker and Apple container pull cannot access the registry, load it manually:

```bash
docker save <your-image> -o /tmp/pi-sandbox-image.tar
container image load --input /tmp/pi-sandbox-image.tar
```

## Config files

Merged in this order (later wins):

1. `~/.pi/agent/sandbox.json`
2. `~/.pi/agent/docker-sandbox.json`
3. `<project>/.pi/sandbox.json`
4. `<project>/.pi/docker-sandbox.json`

See `sandbox.example.json` for the full schema.

## Flags

- `--sandbox`
- `--no-sandbox`
- `--sandbox-backend <container|runtime>`
- `--sandbox-engine <docker|apple>`
- `--sandbox-image <image>`
- `--sandbox-network <mode>`
- `--sandbox-shell <shell>`
- `--sandbox-user <uid:gid|user>`
- `--sandbox-pull-policy <always|if-missing|never>`

## Commands

- `/sandbox`
- `/sandbox start`
- `/sandbox stop`
- `/sandbox restart`
- `/sandbox toggle`
- `/sandbox backend [container|runtime]`
- `/sandbox engine [docker|apple]`
- `/sandbox-shell`

## Tool names

When sandbox is active, built-in tools are remapped to sandboxed variants:

**Container backend** remaps all 7 tools:

- `container_bash`, `container_read`, `container_write`, `container_edit`, `container_grep`, `container_find`, `container_ls`

**Runtime backend** remaps only `bash` (and `user-bash`) to `container_bash`, wrapping it with `@anthropic-ai/sandbox-runtime` policies. File tools (`read`, `write`, `edit`, `grep`, `find`, `ls`) are left as-is since runtime policies apply at the process level.

## Hooks

Supported hooks:

- `hooks.preInit[]` (host)
- `hooks.postInit[]` (host)
- `hooks.containerInit[]` (inside container backend)
- `hooks.preCommand[]` (before each bash command in active backend)
- `hooks.postShutdown[]` (host)

Options:

- `hooks.failOnError` (default `true`)
- `hooks.timeoutSec` (default `120`)

## Troubleshooting

### `Sandbox failed to start: spawn container ENOENT`

The Apple `container` CLI is not installed or not on PATH.
Install with Homebrew and verify:

```bash
brew install container
container --version
```

### `Sandbox failed to start: ... 401 Unauthorized ... no credentials found`

Apple engine failed to pull from registry without credentials.
Either:

- login with `container registry login`, or
- load image from Docker tar (`docker save` + `container image load`).
