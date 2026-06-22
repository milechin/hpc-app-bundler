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
name: hpc-bundler
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

Tell the user:

> You are running on the host, not inside the sandbox container. The `/hpc-bundle`
> command must be run from inside the container session.
>
> Exit this session and launch the sandbox first:
> ```bash
> ./launch-sandbox.sh ./bundles
> ```
> Then run `/hpc-bundle` inside the new session.

Do not attempt to run the workflow from the host.

---

When the workflow completes, report:
1. The path to the bundle tarball
2. The list of dependencies that were bundled
3. How to install on the enclave: `tar xf <bundle>.tar.gz && bash <bundle>/install.sh`
