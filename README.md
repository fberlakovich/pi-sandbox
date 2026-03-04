# pi-sandbox extension

Container sandbox extension for pi.

## Install as global extension

```bash
mkdir -p ~/.pi-work/extensions
ln -sfn ~/repositories/pi-sandbox ~/.pi-work/extensions/pi-sandbox
```

The extension entrypoint is `index.ts` at repository root, so the symlinked directory can be loaded directly.

## Flags

- `--sandbox`
- `--no-sandbox`
- `--sandbox-image <image>`
- `--sandbox-network <mode>`
- `--sandbox-shell <shell>`
- `--sandbox-user <uid:gid|user>`

## Commands

- `/sandbox`
- `/sandbox start`
- `/sandbox stop`
- `/sandbox restart`
- `/sandbox toggle`
- `/sandbox-shell`

## Notes

- Tool names stay `docker_*` for compatibility with existing tool wiring.
- Example config: `sandbox.example.json`
