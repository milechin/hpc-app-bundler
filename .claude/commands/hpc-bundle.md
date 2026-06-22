# hpc-bundle

Build software from source and produce a portable offline bundle for air-gapped HPC environments.

**Usage:** `/hpc-bundle <software> <version> [--output-dir <dir>]`

**Examples:**
- `/hpc-bundle zlib 1.3.1`
- `/hpc-bundle python 3.12.3`
- `/hpc-bundle hdf5 1.14.3 --output-dir /shared/bundles`

## Instructions

**Step 1 — parse the user's command:**

Extract the following values from the arguments the user typed:
- `softwareName` = the first positional argument (e.g. if user typed `/hpc-bundle zlib 1.3.1`, softwareName = `zlib`)
- `softwareVersion` = the second positional argument (e.g. `1.3.1`)
- `outputDir` = the value after `--output-dir` if present, otherwise use `/bundle/output`

**Step 2 — detect which mode to use:**

Run: `test -f /.dockerenv && echo IN_CONTAINER || echo ON_HOST`

---

### If IN_CONTAINER

Run the `hpc-bundler-local` workflow. Pass the args object using the actual
values you parsed in Step 1 — do NOT pass placeholder strings:

```
name: hpc-bundler-local
args:
  software:      <the actual softwareName you parsed>
  version:       <the actual softwareVersion you parsed>
  outputDir:     <the actual outputDir>
  installPrefix: /home/builder/pkg
  maxRetries:    3
```

For example, for `/hpc-bundle zlib 1.3.1` the args must be:
```json
{"software":"zlib","version":"1.3.1","outputDir":"/bundle/output","installPrefix":"/home/builder/pkg","maxRetries":3}
```

Bundles are written to `/bundle/output/` inside the container, which maps to
the directory you passed to `launch-sandbox.sh` on your host.

---

### If ON_HOST

Run: `echo "${HPC_BUNDLER_PROJECT_DIR:-unset}"` to get the project directory.
If it prints "unset", copy `.claude/settings.json.example` to `.claude/settings.json`
and fill in your paths before continuing.

Run the `hpc-bundler` workflow with the actual parsed values:

```
name: hpc-bundler
args:
  software:      <the actual softwareName you parsed>
  version:       <the actual softwareVersion you parsed>
  outputDir:     <the actual outputDir, default ./bundles>
  installPrefix: $HOME/pkg
  maxRetries:    3
  projectDir:    <value of $HPC_BUNDLER_PROJECT_DIR env var>
```

---

When the workflow completes, report:
1. The path to the bundle tarball
2. The list of dependencies that were bundled
3. How to install on the enclave: `tar xf <bundle>.tar.gz && bash <bundle>/install.sh`
