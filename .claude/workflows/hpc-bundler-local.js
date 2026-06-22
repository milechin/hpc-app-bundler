// Container-native workflow — runs entirely inside the Docker sandbox.
// Launched via launch-sandbox.sh; no docker calls needed here.
// All bash commands execute directly in the container.
// Output is written to /bundle (volume-mounted to the host).

export const meta = {
  name: 'hpc-bundler-local',
  description: 'Build and bundle HPC software (container-native, no docker calls)',
  phases: [
    { title: 'Probe',    detail: 'Detect what is already installed in this container' },
    { title: 'Resolve',  detail: 'Fetch Spack/conda-forge recipes, build dep tree' },
    { title: 'Download', detail: 'Download and verify source tarballs' },
    { title: 'Build',    detail: 'Compile each dependency in topological order' },
    { title: 'Validate',         detail: 'Verify the install works correctly' },
    { title: 'Lessons Learned', detail: 'Summarize build discoveries for future runs' },
    { title: 'Bundle',          detail: 'Write install.sh, modulefile, manifest, tar.gz' },
    { title: 'Report',          detail: 'Write failure report for infrastructure errors' },
  ],
}

// args: { software, version, outputDir, installPrefix, maxRetries }
if (!args || !args.software || !args.version) {
  throw new Error(`Missing required args. Received: ${JSON.stringify(args)}. Pass software and version explicitly.`)
}

const software      = args.software
const version       = args.version
const outputDir     = args.outputDir     || '/bundle/output'
const installPrefix = args.installPrefix || '/home/builder/pkg'
const maxRetries    = args.maxRetries    || 3
const bundleDir     = `/bundle/${software}-${version}-bundle`
const logDir        = `${bundleDir}/logs`

// ── Infrastructure failure report ─────────────────────────────────────────────
// Called when a Python helper script crashes or the environment is broken.
// Collects diagnostics, writes failure-report.md, and returns — caller must throw.
// Does NOT retry, does NOT troubleshoot, does NOT install anything.
async function writeInfraReport(phase, errorOutput) {
  await agent(
    `An infrastructure failure occurred in the ${phase} phase of the ${software} ${version} build.
  Your ONLY job is to collect diagnostic information and write a report.
  Do NOT attempt to fix anything. Do NOT retry commands. Do NOT install packages.

  Run these diagnostic commands and capture their full output:
  1. df -h /bundle /tmp /home/builder
  2. free -m
  3. python3.11 --version
  4. python3.11 -c "import hpc_bundler; print('hpc_bundler: OK')" 2>&1
  5. ls -la ${bundleDir}/ 2>/dev/null || echo "(bundle dir does not exist yet)"

  Then write ${bundleDir}/failure-report.md with this exact structure
  (create the bundle dir first if it does not exist):

  # Infrastructure Failure Report

  **Software:** ${software} ${version}
  **Phase:** ${phase}
  **Failure type:** INFRA_FAILURE

  ## Error Output

  \`\`\`
  ${errorOutput}
  \`\`\`

  ## System State

  (paste df and free -m output here)

  ## Python Module Check

  (paste python3.11 --version and import check output here)

  ## Files in Bundle Directory

  (paste ls output here)

  ## Next Steps for Investigation

  This is an infrastructure problem — the build environment or helper scripts failed,
  not the software being compiled. Do not retry the workflow until this is resolved.

  Suggested checks:
  1. Verify the helper module is importable:
       python3.11 -m hpc_bundler.cli.probe --help
  2. Check available disk space: df -h /bundle
  3. If the module is missing, the Docker image may need to be rebuilt:
       docker rmi hpc-bundler-sandbox:v2
       then re-run ./launch-sandbox.sh
  4. Review the error output above for the root cause.

  Return "REPORT_WRITTEN".`,
    { label: 'infra-report', phase: 'Report', model: 'haiku' }
  )
}

// ── Phase: Probe ──────────────────────────────────────────────────────────────
snap('probe-start')
phase('Probe')
const probeResult = await agent(
  `Run the environment probe to detect what is already installed in this container.

  Run: python3.11 -m hpc_bundler.cli.probe --direct ${bundleDir}

  This will create ${bundleDir}/probe.json.

  IMPORTANT: If the command exits non-zero or produces a Python traceback or ImportError,
  return exactly: INFRA_FAILURE: <paste the exact error output>
  Do NOT attempt to fix or work around the error.

  If the command succeeds, read and return the contents of ${bundleDir}/probe.json.`,
  { label: 'env-probe', phase: 'Probe', model: 'haiku' }
)

if (!probeResult || probeResult.startsWith('INFRA_FAILURE')) {
  await writeInfraReport('Probe', probeResult || 'probe agent returned null')
  throw new Error(`Infrastructure failure in Probe phase. See ${bundleDir}/failure-report.md`)
}

// ── Token tracking ────────────────────────────────────────────────────────────
const tokenLog = []
function snap(label) { tokenLog.push({ label, spent: budget.spent() }) }

// ── Retry loop ────────────────────────────────────────────────────────────────
// Retries on BUILD_FAILURE, DOWNLOAD_FAILURE, VALIDATION_FAILED.
// Stops immediately on INFRA_FAILURE (Python script crash / environment problem).
// Stops early if two consecutive retries produce the same failure (stall detection).
let retryCount = 0
let previousFailure = null
let lastFailure = null   // failure from the attempt before previousFailure — stall detection
let validationPassed = false

// ── Prior build knowledge ─────────────────────────────────────────────────────
// Read lessons from a previous successful build of this software, if available.
// Injected into the resolver on attempt 0 to skip rediscovering known solutions.
let priorKnowledge = ''
const knowledgeBasePath = `${outputDir}/knowledge-base/${software}.md`
const priorResult = await agent(
  `Check if ${knowledgeBasePath} exists. If it does, read and return its full content.
  If it does not exist, return exactly: NO_PRIOR_KNOWLEDGE`,
  { label: 'read-knowledge-base', phase: 'Resolve', model: 'haiku' }
)
if (priorResult && !priorResult.startsWith('NO_PRIOR_KNOWLEDGE')) {
  priorKnowledge = priorResult
  log(`Prior build knowledge found for ${software} — injecting into resolver`)
}

while (retryCount <= maxRetries) {
  if (retryCount > 0) {
    log(`Retry ${retryCount}/${maxRetries}`)
  }

  // ── Phase: Resolve ──────────────────────────────────────────────────────────
  snap(`resolve-${retryCount}-start`)
  phase('Resolve')
  await agent(
    `You are an expert HPC dependency resolver for AlmaLinux 9.7 (x86_64).

  Target package: ${software} ${version}
  Install prefix pattern: ${installPrefix}/<name>/<version>

  SYSTEM BASELINE — already present in this container (DO NOT include these):
  ${probeResult}

  ${retryCount === 0 && priorKnowledge ? `PRIOR BUILD KNOWLEDGE — a previous successful build of ${software} left these notes.\nUse them as your starting point — incorporate agent-reasoned deps directly into the dep tree without re-discovering them:\n\n${priorKnowledge}\n` : ''}
  ${previousFailure ? `PREVIOUS FAILURE — adjust the dep tree to fix this:\n${previousFailure}\n` : ''}

  Steps:
  1. Use WebFetch to retrieve the Spack recipe (try primary URL first, fall back to secondary):
     Primary:  https://raw.githubusercontent.com/spack/spack-packages/develop/repos/spack_repo/builtin/packages/${software.toLowerCase()}/package.py
     Fallback: https://raw.githubusercontent.com/spack/spack/develop/var/spack/repos/builtin/packages/${software.toLowerCase()}/package.py

  2. Use WebFetch to retrieve the conda-forge recipe:
     https://raw.githubusercontent.com/conda-forge/${software.toLowerCase()}-feedstock/main/recipe/meta.yaml
     https://raw.githubusercontent.com/conda-forge/${software.toLowerCase()}-feedstock/main/recipe/build.sh

  3. Parse the recipes to extract all build-time dependencies. For each dep:
     - name, version (concrete — no version ranges)
     - source_url (direct tarball download URL)
     - sha256 checksum
     - build_system: autotools | cmake | meson | pip | custom
     - configure_flags
     - build_order: 1 = leaf dep, increasing toward the target

  4. Exclude anything already in the system baseline above.

  5. Write ${bundleDir}/dep_tree.json:
     {
       "target": "${software}",
       "version": "${version}",
       "dependencies": [
         {
           "name": "string", "version": "string",
           "source_url": "string", "sha256": "string",
           "file": "sources/<name>-<version>.tar.gz",
           "build_system": "autotools|cmake|meson|pip|custom",
           "configure_flags": [], "env_vars": {}, "patches": [],
           "build_order": 1,
           "recipe_source": "spack|conda-forge|agent-reasoning",
           "is_target": false
         }
       ],
       "warnings": []
     }
     Mark ${software} itself with "is_target": true and the highest build_order.

  Use the Write tool for both files.

  6. Write ${logDir}/resolve-attempt-${retryCount}.md with a plain-English summary:

     # Resolve Log — ${software} ${version} (attempt ${retryCount})

     ## Recipe Sources
     - What the Spack recipe listed as dependencies (package names, version constraints)
     - What conda-forge recipe listed
     - Which source took precedence for each dep and why

     ## Dependency Decisions
     For each dep in the final tree: name, version chosen, why that version, source URL origin

     ## Excluded (already in system baseline)
     List anything that was skipped because probe.json showed it already present

     ## Warnings / Concerns
     Anything uncertain: agent-reasoned URLs, missing checksums, unusual build systems

     ${retryCount > 0 ? `## Why This Retry Was Triggered\n\nThe previous attempt failed with this error (copied verbatim from the workflow):\n\n\`\`\`\n${previousFailure}\n\`\`\`\n\n## Changes from Previous Attempt\nWhat was adjusted in the dep tree or build flags to address the failure above` : ''}

  Return a brief summary of what you found.`,
    { label: `dep-resolve-${retryCount}`, phase: 'Resolve', effort: 'medium' }
  )

  // ── Phase: Download ─────────────────────────────────────────────────────────
  snap(`download-${retryCount}-start`)
  phase('Download')
  const downloadResult = await agent(
    `Download all source tarballs listed in ${bundleDir}/dep_tree.json.

  Run: python3.11 -m hpc_bundler.cli.download ${bundleDir}/dep_tree.json

  After the command completes, write ${logDir}/download-attempt-${retryCount}.md:

  # Download Log — ${software} ${version} (attempt ${retryCount})

  ## Packages Attempted
  List each tarball: name, version, URL, file size, sha256 status (verified / mismatch / skipped)

  ## Outcome
  SUCCESS or FAILURE — and if failed, the exact package, URL, and error

  ## Failure Detail (if any)
  HTTP status code, checksum expected vs actual, or network error message

  IMPORTANT — return one of these exact prefixes:
  - INFRA_FAILURE: <exact output>  — if the python3.11 script itself crashes
      (Python traceback, ImportError, PermissionError, or any unexpected exception).
      Do NOT attempt to fix this.
  - DOWNLOAD_FAILURE: <details>    — if a tarball fails to download
      (HTTP 404, checksum mismatch, network timeout).
  - SUCCESS                        — if all tarballs downloaded and verified.`,
    { label: `download-${retryCount}`, phase: 'Download', model: 'haiku' }
  )

  if (!downloadResult) {
    log(`Download agent returned null (API connection dropped) — retrying`)
    previousFailure = 'Download agent returned null (API connection dropped)'
    retryCount++
    continue
  }
  if (downloadResult.startsWith('INFRA_FAILURE')) {
    await writeInfraReport('Download', downloadResult)
    throw new Error(`Infrastructure failure in Download phase. See ${bundleDir}/failure-report.md`)
  }
  if (downloadResult.startsWith('DOWNLOAD_FAILURE')) {
    const thisFailure = `Download failed: ${downloadResult}`
    log(`Download failed: ${downloadResult}`)
    if (thisFailure === previousFailure) {
      throw new Error(`Stalled: Download failed with the same error twice in a row. No progress made.\n${thisFailure}`)
    }
    lastFailure = previousFailure
    previousFailure = thisFailure
    retryCount++
    continue
  }

  snap(`build-${retryCount}-start`)
  // ── Phase: Build ────────────────────────────────────────────────────────────
  phase('Build')
  const buildResult = await agent(
    `Build all dependencies for ${software} ${version} from source.
  You are running directly inside the AlmaLinux 9.7 build container.

  Read ${bundleDir}/dep_tree.json for the dependency list.
  Process each dependency in ascending build_order.

  For each dependency:
  1. Check if already installed:
     Run: ls ${installPrefix}/<name>/<version>/ 2>/dev/null | wc -l
     If the output is greater than 0, the package is already installed — skip steps 2-5,
     mark it as "done (cached)" in the progress file, and move to the next package.

  2. Determine the build commands:
     - Source tarball: ${bundleDir}/sources/<name>-<version>.tar.gz
     - Install to: ${installPrefix}/<name>/<version>
     - GCC 14 is on PATH; also set CC, CXX, FC explicitly.
     - autotools: cd /tmp && tar xf ${bundleDir}/sources/<tarball> && cd <dir> && ./configure --prefix=${installPrefix}/<name>/<ver> <flags> && make -j$(nproc) && make install
     - cmake:     cd /tmp && tar xf ${bundleDir}/sources/<tarball> && cd <dir> && mkdir _build && cd _build && cmake -DCMAKE_INSTALL_PREFIX=${installPrefix}/<name>/<ver> <flags> .. && make -j$(nproc) && make install
     - meson:     cd /tmp && tar xf ${bundleDir}/sources/<tarball> && cd <dir> && meson setup _build --prefix=${installPrefix}/<name>/<ver> && ninja -C _build && ninja -C _build install
     - pip:       pip3 install --no-deps --prefix=${installPrefix}/<name>/<ver> ${bundleDir}/sources/<tarball>

  3. Write commands to ${bundleDir}/commands_<name>.json:
     {"package_name": "...", "package_version": "...", "commands": [...]}

  4. BEFORE running any build commands:
     a. Run: date '+%Y-%m-%d %H:%M:%S'  to get the current timestamp.
     b. Rewrite ${logDir}/build-progress.md to mark this package as "building...".
        Use the Write tool directly — do not skip this step.

  5. Execute: python3.11 -m hpc_bundler.cli.build_exec --direct --network-isolated ${bundleDir}/commands_<name>.json
     This runs the commands in a network-isolated environment (no internet) and appends results to ${bundleDir}/build_log.json.

     NETWORK NOTE: Each command runs with only loopback available — no outbound internet.
     If a command fails with "Network unreachable", "Could not resolve host", "Connection timed out",
     or "Failed to connect", the build step attempted to download something at compile time.
     Return BUILD_FAILURE: <package> — attempted network access during build: <url or tool name>.
     The resolver will add the missing source to dep_tree.json on the next retry.

  6. IMMEDIATELY after build_exec returns:
     a. Run: date '+%Y-%m-%d %H:%M:%S'  to get the current timestamp.
     b. Rewrite ${logDir}/build-progress.md to mark this package as "done" or "FAILED".
        Use the Write tool directly — do not skip this step.

     Format (update every row — pending, building..., done, or FAILED):

     # Build Progress — ${software} ${version} (attempt ${retryCount})

     | # | Package | Version | Started | Finished | Status |
     |---|---------|---------|---------|----------|--------|
     | 1 | zlib    | 1.3.1   |                     |                     | done (cached) |
     | 2 | proj    | 9.4.0   | 2026-06-22 15:10:01 | 2026-06-22 15:11:45 | done          |
     | 3 | geos    | 3.12.1  | 2026-06-22 15:11:46 |                     | building...   |
     | 4 | gdal    | 3.13.1  |                     |                     | pending       |

     Leave Started/Finished blank for pending and cached packages.
     Fill in Started when a package begins building, Finished when it ends.
     Use "done (cached)" for packages skipped because they were already installed.

     This file is the ONLY way the user can see what is happening. Writing it is
     mandatory — treat it as part of the build step, not optional housekeeping.

  After all packages complete (or on failure), write ${logDir}/build-attempt-${retryCount}.md:

  # Build Log — ${software} ${version} (attempt ${retryCount})

  ## Packages Built
  For each package: name/version, build system detected, configure flags used, install path, outcome (success/fail)

  ## Compiler Info
  GCC version used, any toolchain notes

  ## Warnings
  Any notable warnings from make/configure that might affect correctness

  ## Failure Detail (if any)
  Exact package, command, and stderr that caused the failure

  IMPORTANT — return one of these exact prefixes:
  - INFRA_FAILURE: <exact output>  — if python3.11 -m hpc_bundler.cli.build_exec crashes
      (Python traceback, ImportError, or unexpected exception — NOT a compile error).
      Do NOT attempt to fix this.
  - BUILD_FAILURE: <package> — <stderr from the failing compile/link command>
      — if a build command fails (make error, configure error, linker error).
  - SUCCESS                        — if all packages compiled and installed.`,
    { label: `build-${retryCount}`, phase: 'Build', effort: 'medium' }
  )

  if (!buildResult) {
    log(`Build agent returned null (API connection dropped) — retrying`)
    previousFailure = 'Build agent returned null (API connection dropped)'
    retryCount++
    continue
  }
  if (buildResult.startsWith('INFRA_FAILURE')) {
    await writeInfraReport('Build', buildResult)
    throw new Error(`Infrastructure failure in Build phase. See ${bundleDir}/failure-report.md`)
  }
  if (buildResult.startsWith('BUILD_FAILURE')) {
    log(`Build failed (attempt ${retryCount + 1}): ${buildResult}`)
    if (buildResult === previousFailure) {
      throw new Error(`Stalled: Build failed with the same error twice in a row. No progress made.\n${buildResult}`)
    }
    lastFailure = previousFailure
    previousFailure = buildResult
    retryCount++
    continue
  }

  snap(`validate-${retryCount}-start`)
  // ── Phase: Validate ─────────────────────────────────────────────────────────
  phase('Validate')
  const validationResult = await agent(
    `Verify the install of ${software} ${version}.

  Run: python3.11 -m hpc_bundler.cli.validate --direct --install-prefix ${installPrefix} ${bundleDir}/dep_tree.json

  This checks:
  - Network connectivity (enforced — build commands ran in an isolated network namespace)
  - Install prefix exists at ${installPrefix}/${software}/${version}/
  - Binary or library files are present (bin/, lib/, or lib64/ — cmake packages often use lib64/ on x86_64)
  - No missing shared libraries (ldd run with LD_LIBRARY_PATH set from all dep prefixes)
  - Version invocation works (run with LD_LIBRARY_PATH set, skipped for library-only packages)

  The ldd and version checks simulate what `module load` does on the enclave — LD_LIBRARY_PATH
  is constructed from all dependency install prefixes automatically by the script. Binaries do
  NOT need RPATH embedded; do NOT add -DCMAKE_INSTALL_RPATH or -Wl,-rpath to build flags.

  Results are written to ${bundleDir}/validation.json.

  After the script completes, write ${logDir}/validate-attempt-${retryCount}.md:

  # Validation Log — ${software} ${version} (attempt ${retryCount})

  ## Install Prefix Checked
  Path that was inspected

  ## Check Results
  For each check in validation.json: name, passed/failed, what was found

  ## Outcome
  PASSED or FAILED — and if failed, the specific reason

  IMPORTANT — return one of these exact prefixes based ONLY on the "success" field in
  validation.json (do NOT fail based on advisory checks):
  - INFRA_FAILURE: <exact output>     — if python3.11 -m hpc_bundler.cli.validate crashes
      (Python traceback, ImportError, or unexpected exception — script does not produce JSON).
      Do NOT attempt to fix this.
  - VALIDATION_FAILED: <reason>       — ONLY if "success": false in validation.json
      (binary_exists, no_missing_libs, or version_check failed).
  - PASSED                            — if "success": true in validation.json.`,
    { label: `validate-${retryCount}`, phase: 'Validate', model: 'haiku' }
  )

  if (!validationResult) {
    log(`Validate agent returned null (API connection dropped) — retrying`)
    previousFailure = 'Validate agent returned null (API connection dropped)'
    retryCount++
    continue
  }
  if (validationResult.startsWith('INFRA_FAILURE')) {
    await writeInfraReport('Validate', validationResult)
    throw new Error(`Infrastructure failure in Validate phase. See ${bundleDir}/failure-report.md`)
  }
  if (validationResult.startsWith('PASSED')) {
    log('Validation passed!')
    validationPassed = true
    break
  }

  log(`Validation failed (attempt ${retryCount + 1}): ${validationResult}`)
  const thisValidationFailure = `Validation failed: ${validationResult}`
  if (thisValidationFailure === previousFailure) {
    throw new Error(`Stalled: Validation failed with the same error twice in a row. No progress made.\n${thisValidationFailure}`)
  }
  lastFailure = previousFailure
  previousFailure = thisValidationFailure
  retryCount++
}

if (!validationPassed) {
  throw new Error(`Failed to install ${software} ${version} after ${maxRetries} retries. Last: ${previousFailure}`)
}

// ── Phase: Lessons Learned ────────────────────────────────────────────────────
phase('Lessons Learned')
await agent(
  `A build of ${software} ${version} just succeeded after ${retryCount} retries.
  Write a compact lessons-learned summary that will help future builds of ${software}
  start with better information.

  Read these files:
  - ${bundleDir}/dep_tree.json — focus on "recipe_source": "agent-reasoning" entries and the "warnings" array
  - ${bundleDir}/logs/resolve-attempt-0.md through resolve-attempt-${retryCount > 0 ? retryCount - 1 : 0}.md — what changed on each retry
  - ${bundleDir}/logs/build-attempt-0.md — packages that needed special flags or failed initially

  Write IDENTICAL content to BOTH of these files:
  - ${bundleDir}/logs/lessons-learned.md
  - ${outputDir}/knowledge-base/${software}.md
  Create ${outputDir}/knowledge-base/ first if it does not exist.

  Use this structure (omit any section that has nothing to add):

  # Build Notes: ${software} ${version}

  ## Dependencies not in Spack/conda-forge (agent-reasoned)
  One bullet per agent-reasoned dep: name, version, why it was needed, any special build notes.

  ## URL corrections
  Any source URLs that were wrong in recipes and what the correct URL was.

  ## Configure flags discovered through failures
  Only flags that were non-obvious or required a retry to discover.

  ## Build order constraints
  Any non-obvious ordering requirements (A must precede B because of X).

  ## Retry history
  One line: "N retries: brief description of what each retry fixed"
  Write "0 retries: built successfully on first attempt" if retryCount is 0.

  Keep each bullet to one line. Omit empty sections entirely. Be concise.
  Return "LESSONS_WRITTEN".`,
  { label: 'lessons-learned', phase: 'Lessons Learned', model: 'haiku' }
)

snap('bundle-start')
// ── Phase: Bundle ──────────────────────────────────────────────────────────────
phase('Bundle')
const assembleResult = await agent(
  `Assemble the final offline bundle for ${software} ${version}.

  Run: python3.11 -m hpc_bundler.cli.assemble ${bundleDir} ${outputDir}

  This renders install.sh and the Lua modulefile from the build log,
  writes manifest.json and README.md, and creates:
    ${outputDir}/${software}-${version}-bundle.tar.gz

  IMPORTANT: If the python3.11 script crashes (Python traceback, ImportError, or any
  unexpected exception), return: INFRA_FAILURE: <exact error output>
  Do NOT attempt to fix it.

  Return the path to the tarball on success.`,
  { label: 'assemble-bundle', phase: 'Bundle', model: 'haiku' }
)

if (!assembleResult) {
  throw new Error(`Bundle agent returned null (API connection dropped). Re-run /hpc-bundle to retry from the Bundle phase.`)
}
if (assembleResult.startsWith('INFRA_FAILURE')) {
  await writeInfraReport('Bundle', assembleResult)
  throw new Error(`Infrastructure failure in Bundle phase. See ${bundleDir}/failure-report.md`)
}

snap('bundle-done')
log(`Bundle ready: ${assembleResult}`)

// ── Token usage summary ───────────────────────────────────────────────────────
const totalSpent = budget.spent()
const phaseRows = []
for (let i = 1; i < tokenLog.length; i++) {
  const delta = tokenLog[i].spent - tokenLog[i - 1].spent
  phaseRows.push(`| ${tokenLog[i].label} | ${delta} |`)
}
const tokenSummary = [
  `# Token Usage — ${software} ${version}`,
  ``,
  `| Phase | Output Tokens |`,
  `|---|---|`,
  ...phaseRows,
  ``,
  `**Total output tokens:** ${totalSpent}`,
  ``,
  `_Output tokens only. Each agent also consumes input tokens (context) not tracked here._`,
].join('\n')
await agent(
  `Write the file ${logDir}/token-usage.md with exactly this content — do not add or change anything:\n\n${tokenSummary}\n\nReturn "WRITTEN".`,
  { label: 'token-log', phase: 'Bundle', model: 'haiku' }
)

return `Bundle created: ${outputDir}/${software}-${version}-bundle.tar.gz`
