# hpc-bundler

An agentic tool that builds arbitrary software from source and packages it into a
self-contained bundle for offline installation in air-gapped HPC environments.

Built for Boston University's tiCrypt secure enclave, where outbound internet is
blocked and users do not have sudo access.

---

## How it works

**Phase 1 — Online (your workstation):**
1. Resolves the full dependency tree by reading Spack and conda-forge recipes
2. Downloads all source tarballs and verifies checksums
3. Compiles everything from source inside an isolated AlmaLinux 9.7 Docker container
4. Verifies the install works correctly
5. Packages the result into a portable `<software>-<version>-bundle.tar.gz`

**Phase 2 — Offline (the enclave):**
1. Copy the bundle tarball to the enclave
2. Extract and run `install.sh`
3. Load with `module load <software>/<version>`

All builds use GCC 14 and are compiled from source to avoid glibc mismatch issues
common on HPC systems. The install prefix is not baked in — researchers set it at
install time.

---

## Prerequisites

- Docker installed and running on your workstation
- A Claude Code session (Claude.ai subscription — no API key needed)

---

## Quick start

No local Python setup required — the helper package is pre-installed inside the
Docker image.

```bash
./launch-sandbox.sh ./bundles
```

This builds the Docker image on first run (~25–30 minutes), starts an isolated
container, and drops you into a Claude Code session inside it. Then:

```
/hpc-bundle zlib 1.3.1
/hpc-bundle python 3.12.3
/hpc-bundle hdf5 1.14.3
```

Bundles appear in `./bundles/` on your host when complete. Type `exit` to leave
the container session.

---

## Usage modes

### Mode 1 — Container-native (recommended)

Claude Code runs *inside* the Docker sandbox. Your host filesystem is completely
isolated — Claude only has access to the bundle output directory and your Claude
credentials (read-only).

**No local Python setup required.** The helper package is baked into the Docker
image at build time (Python 3.11 + pip baked into the Dockerfile).

```bash
./launch-sandbox.sh [output-dir]
# default output-dir is ./bundles
```

Inside the session:
```
/hpc-bundle <software> <version>
/hpc-bundle <software> <version> --output-dir /bundle/custom-dir
```

### Mode 2 — Host-based

Claude Code runs on your host and manages Docker on your behalf. Use this if you
prefer to keep Claude Code running in your normal environment.

Because Claude runs on the host here, the helper package must also be installed
locally so the host-side workflow can call it.

**One-time setup:**
```bash
python3 -m venv .venv
.venv/bin/pip install -e .
```

Copy the example settings file and fill in your paths:
```bash
cp .claude/settings.json.example .claude/settings.json
# then edit .claude/settings.json with your actual paths
```

```json
{
  "env": {
    "VIRTUAL_ENV": "/path/to/your/sandbox_package_install/.venv",
    "HPC_BUNDLER_PROJECT_DIR": "/path/to/your/sandbox_package_install"
  }
}
```

Open a Claude Code session in this directory, then use `/hpc-bundle` as normal.
The skill auto-detects which mode you are in and routes to the correct workflow.

---

## Bundle structure

```
<software>-<version>-bundle/
├── sources/                   # All source tarballs (sha256 verified)
│   ├── zlib-1.3.1.tar.gz
│   └── <software>-<version>.tar.gz
├── patches/                   # Any patches applied during the build
├── logs/                      # Per-phase reasoning logs (plain Markdown)
│   ├── resolve-attempt-0.md   # What deps were chosen and why
│   ├── download-attempt-0.md  # Tarball URLs, sizes, checksum results
│   ├── build-progress.md      # Live status table — updated after each package
│   ├── build-attempt-0.md     # Full build log written when build phase ends
│   ├── validate-attempt-0.md  # Which checks passed/failed and why
│   ├── lessons-learned.md     # Build discoveries captured after success
│   └── token-usage.md         # Output token consumption per phase
├── install.sh                 # Offline build + install script
├── manifest.json              # Checksums, versions, build order
├── modulefiles/
│   └── <software>/
│       └── <version>.lua      # lmod modulefile
└── README.md
```

---

## Installing the bundle on the enclave

Copy the tarball to the enclave, then:

```bash
tar xf <software>-<version>-bundle.tar.gz
cd <software>-<version>-bundle
bash install.sh
```

Software installs to `$HOME/pkg/<software>/<version>` by default.
To use a shared or custom location:

```bash
INSTALL_PREFIX=/shared/apps MODULEFILE_DIR=/shared/modulefiles bash install.sh
```

Load the software:

```bash
module use $HOME/modulefiles
module load <software>/<version>
```

---

## Configuration

### Install prefix (set on the enclave at install time)

The prefix is never baked into the bundle. Pass environment variables to `install.sh`:

```bash
INSTALL_PREFIX=/project/tools MODULEFILE_DIR=/project/modulefiles bash install.sh
```

### Bundle output directory (set when running the workflow)

```
/hpc-bundle python 3.12.3 --output-dir /tmp/hpc-bundles
```

### Moving to a different workstation

**Container-native mode:** copy the repo, run `./launch-sandbox.sh`. The image
will be rebuilt automatically on first use. No other configuration needed.

**Host-based mode:** copy the repo, create a new venv, update the `VIRTUAL_ENV`
path in `.claude/settings.json`, rebuild the Docker image.

---

## Security model

### Container-native mode

Claude Code runs *inside* the container with `--dangerously-skip-permissions`.
The `--dangerously-skip-permissions` flag is safe here because the container is
the isolation boundary — there is nothing sensitive inside it to protect.

Your host filesystem is never touched. The only host path the container can
see is the one explicit volume mount:

| Mount | Access | Purpose |
|---|---|---|
| `./bundles/` → `/bundle` | Read-write | Source tarballs in, build artifacts out |

No credentials are copied from your host. Authenticate manually by running `/login`
inside the container session. Authentication state lives only inside the container
and is discarded when it exits.

**Managed policy** — `managed-settings.json` is baked into the image at
`/etc/claude-code/managed-settings.json`. It applies at the highest precedence
(overrides all user settings) and currently disables WebSearch so all source
resolution uses dep_tree.json URLs rather than live search results.

**Network isolation:** each build command runs inside a `unshare --user --net`
namespace so it has no outbound internet access. Any step that tries to download
something at compile time fails immediately with a clear error, which feeds back
to the resolver on the next retry. The validation step confirms the isolation
mechanism is working by running a test curl inside `unshare --net`. The container
itself retains internet access throughout — the Claude agent needs it to reach
Anthropic. For a fully offline install test, extract the bundle on a machine with
no internet and run `install.sh` manually.

### Host-based mode

Claude runs on your host with normal permission prompts for each file or bash
operation. Build work still executes inside the container via `docker exec`.

---

## Dependency resolution

Dependencies are resolved in this order:

1. **Spack** (`github.com/spack/spack-packages`) — primary source for compiled HPC
   libraries (MPI, HDF5, NetCDF, BLAS, etc.). Provides source URLs, version
   constraints, and known patches. (Falls back to `github.com/spack/spack` for
   packages not yet migrated to the new repo.)
2. **conda-forge** (`github.com/conda-forge/<name>-feedstock`) — secondary
   source, especially for Python/R packages. The `build.sh` script is often
   directly reusable.
3. **Agent reasoning** — fallback when neither registry has a recipe. These
   dependencies are flagged with `"recipe_source": "agent-reasoning"` in
   `manifest.json`.

The environment probe runs at the start of each build and detects what is
already installed in the container (gcc, cmake, system libraries). Those
packages are excluded from the bundle automatically.

---

## Retry behaviour

If a build or validation fails, the workflow retries up to 3 times. On each
retry, the failure output is passed back to the dependency resolver so it can
adjust the dep tree — add a missing dependency, correct a configure flag, or
change a version.

**Stall detection:** if two consecutive retries fail with identical error output,
the workflow stops immediately rather than exhausting all retries. This prevents
Claude from spinning on a problem it demonstrably cannot fix on its own.

Each retry's `resolve-attempt-N.md` log includes a "Why This Retry Was Triggered"
section quoting the exact failure that caused it, so you can trace what went wrong
without hunting across multiple log files.

To change the retry limit, edit `maxRetries` in `.claude/commands/hpc-bundle.md`.

---

## Build knowledge base

After every successful build, a lessons-learned agent writes a compact summary to
`<output-dir>/knowledge-base/<software>.md`. The next time you build the same
software (version bump, image rebuild, new machine), the resolver reads that file
before the Resolve phase and starts from the known-good baseline — correct dep
versions, required configure flags, agent-reasoned deps not in any recipe — without
having to rediscover them through retries.

The same content is also written to `<bundle>/logs/lessons-learned.md` as a
permanent record alongside the other per-build logs.

---

## Project structure

```
bundles/                                 # Default output directory (host-side)
├── knowledge-base/
│   ├── gdal.md                          # Lessons from previous GDAL builds
│   └── <software>.md                    # One file per software, reused across runs
└── <software>-<version>-bundle/         # Per-build output (see Bundle structure above)

launch-sandbox.sh                        # Start an isolated container-native session

.claude/
├── commands/hpc-bundle.md             # /hpc-bundle skill (auto-detects mode)
├── workflows/
│   ├── hpc-bundler-local.js          # Container-native workflow (no docker calls)
│   └── hpc-bundler.js                # Host-based workflow (manages docker itself)
└── settings.json                        # VIRTUAL_ENV path for host-based mode

hpc_bundler/
├── docker_manager.py                    # Container lifecycle + network toggle
├── env_probe.py                         # Detects what is already installed in container
├── bundle.py                            # Downloads tarballs, verifies checksums, tars bundle
├── render.py                            # Jinja2 rendering of install.sh and modulefile
├── templates/
│   ├── install.sh.j2                    # Offline build script template
│   └── modulefile.lua.j2               # lmod Lua modulefile template
└── cli/
    ├── probe.py                         # Env probe  (--direct: run in current shell)
    ├── download.py                      # Download sources from dep_tree.json
    ├── build_exec.py                    # Execute build commands  (--direct: local shell)
    ├── validate.py                      # Validation checks  (--direct: local shell)
    └── assemble.py                      # Render templates + create final tarball

Dockerfile                               # AlmaLinux 9.7, GCC 14, lmod, Claude Code CLI
managed-settings.json                    # Org policy baked into image (/etc/claude-code/)
pyproject.toml
```
