# hpc-bundler — Claude Code Handoff Brief

## Project Goal

Build an agentic system that figures out how to install arbitrary software into an
air-gapped HPC environment (no internet, no sudo), installs it under an lmod module
system, and produces a portable bundle that can be copied to the production enclave
and installed offline.

This is being built to support researchers using Boston University's tiCrypt secure
enclave, where outbound internet is blocked and users do not have sudo access.

---

## Constraints

- **No sudo.** Software must be installed to a user-writable prefix (e.g., `$HOME/pkg`
  or a shared directory).
- **No internet on target system.** Everything needed must be bundled before transfer.
- **lmod module system.** Each installed package must have a corresponding `.lua`
  modulefile so researchers can load it with `module load <name>/<version>`.
- **Always build from source.** Do not rely on pre-built binaries (glibc mismatch risk
  on HPC). Every dependency is compiled from source tarballs.
- **Configurable prefix.** The install script must not hardcode paths. Use environment
  variables at the top:

```bash
INSTALL_PREFIX=${INSTALL_PREFIX:-$HOME/pkg}
MODULEFILE_DIR=${MODULEFILE_DIR:-$HOME/modulefiles}
BUNDLE_DIR="$(cd "$(dirname "$0")" && pwd)"
```

---

## How the Agent Works

### Two-phase design

**Phase 1 — Online (runs anywhere with internet):**
1. Resolve the full dependency tree for the requested software + version
2. Download all source tarballs to `bundle/sources/`
3. Download any required patches to `bundle/patches/`
4. Verify checksums
5. Write `bundle/manifest.json`
6. Generate `bundle/install.sh`
7. Package the whole bundle as `<software>-<version>-bundle.tar.gz`

**Phase 2 — Offline (runs on the enclave):**
1. Copy bundle tarball to enclave
2. Extract
3. Run `install.sh` (reads manifest for build order, builds all deps then target)
4. `module use $MODULEFILE_DIR && module load <name>/<version>`
5. Verify software runs correctly

### Iterative sandbox loop

The agent runs Phase 1 inside a Docker container with network toggled on, then
toggles network off and runs Phase 2 to verify. If Phase 2 fails, the agent
analyzes the error, updates the dependency tree or build flags, and retries.
Network is toggled externally by the orchestrator (not inside the container):

```bash
docker network disconnect bridge <container>   # cut network
docker network connect bridge <container>      # restore
```

The loop terminates when the software runs cleanly with network disconnected.

---

## Reference Sources for Dependency Resolution

The agent uses two public recipe sources to understand how to build software.
It does NOT install or depend on either tool — they are used as a knowledge base only.

### 1. Spack package index
- Location: `https://github.com/spack/spack/tree/develop/var/spack/repos/builtin/packages`
- Each `package.py` provides: source URLs, dependency list with version constraints,
  build system type (autotools/cmake/meson/pip), known patches
- Best for: HPC/scientific compiled software (MPI, HDF5, NetCDF, BLAS, etc.)
- Limitation: build logic is in Python classes with Spack-specific abstractions —
  agent must translate, not copy verbatim

### 2. conda-forge feedstocks
- Location: `https://github.com/conda-forge/<name>-feedstock/blob/main/recipe/`
- Each feedstock has `meta.yaml` (deps, source URL) and `build.sh` (actual bash build
  script, often near-directly usable)
- Best for: Python/R/data science packages; `build.sh` is easier to translate than
  Spack's Python classes; explicit split between build-time and runtime deps
- Limitation: scripts assume `$PREFIX` variable — substitute with `$INSTALL_PREFIX/<name>/<version>`

### Resolution strategy
1. Check Spack first (better dep tree for compiled HPC tools)
2. Check conda-forge second (better build scripts, better Python/R coverage)
3. Fall back to upstream docs + agent reasoning if neither has a recipe

---

## Bundle Directory Structure

```
<software>-<version>-bundle/
├── sources/                   # All source tarballs in dependency order
│   ├── zlib-1.3.1.tar.gz
│   ├── openssl-3.3.0.tar.gz
│   └── <software>-<version>.tar.gz
├── patches/                   # Any patches referenced in build recipes
│   └── example.patch
├── install.sh                 # Offline install script (see constraints above)
├── manifest.json              # Checksums, versions, build order, source URLs
└── README.md                  # What this installs, how to use it
```

### manifest.json schema

```json
{
  "target": "<software>",
  "version": "<version>",
  "built_for": "x86_64-linux",
  "compiler": "gcc 11.4.0",
  "created": "YYYY-MM-DD",
  "dependencies": [
    {
      "name": "zlib",
      "version": "1.3.1",
      "source_url": "https://zlib.net/zlib-1.3.1.tar.gz",
      "sha256": "<hash>",
      "file": "sources/zlib-1.3.1.tar.gz",
      "build_order": 1
    }
  ]
}
```

---

## Modulefile Format

Each installed package gets a `.lua` modulefile at
`$MODULEFILE_DIR/<name>/<version>.lua`:

```lua
local version = myModuleVersion()
local pkgName = myModuleName()
local prefix  = pathJoin(os.getenv("HOME"), "pkg", pkgName, version)

whatis("Name: " .. pkgName)
whatis("Version: " .. version)

prepend_path("PATH",            pathJoin(prefix, "bin"))
prepend_path("LD_LIBRARY_PATH", pathJoin(prefix, "lib"))
prepend_path("PKG_CONFIG_PATH", pathJoin(prefix, "lib", "pkgconfig"))
```

Deps that must be loaded first should appear as `load("depname/version")` at the
top of the modulefile.

---

## Build Environment Probe

Before attempting any build, the agent runs a probe on the sandbox to establish
baseline — this trims the dependency tree by identifying what's already present:

```bash
gcc --version
cmake --version
make --version
python3 --version
pkg-config --version
ldconfig -p | grep -E "libssl|libz|libffi|libcurl|libm"
module avail 2>&1
```

Dependencies already satisfied by the system do not need to be bundled.

---

## Agent Architecture

```
hpc-bundler (master orchestrator)
  ├── dependency-resolver   — fetches Spack/conda recipes, builds dep tree
  ├── build-agent           — runs configure/make/install in sandbox, records failures
  ├── validator             — cuts network, verifies install works offline
  └── script-writer         — codifies successful build into install.sh + manifest.json
```

Each sub-agent reports structured output back to the orchestrator. The orchestrator
drives the retry loop and decides when the offline verification passes.

---

## Suggested Build Order

1. Docker sandbox setup — container with shared volume, network toggle wrapper script
2. Build environment probe — runs on container startup, outputs baseline JSON
3. Dependency resolver — fetches and parses Spack + conda-forge recipes, outputs dep tree
4. Build agent — executes builds in topological order, captures stdout/stderr
5. Validator — network toggle + offline verification
6. Script writer — generates install.sh + manifest.json from successful build log
7. Bundle packager — tars the bundle directory
8. Skill wrapper — packages everything as an `hpc-bundler` Cowork skill

---

## Out of Scope (for now)

- GPU/CUDA software (adds significant complexity around driver compatibility)
- Windows or macOS targets (Linux only)
- Packages requiring Fortran (may need gfortran probe added to env check)
- Automatic upload to the enclave (manual copy + run for now)