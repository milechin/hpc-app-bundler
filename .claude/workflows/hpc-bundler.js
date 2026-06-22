export const meta = {
  name: 'hpc-bundler',
  description: 'Build and bundle HPC software for air-gapped offline installation',
  phases: [
    { title: 'Setup',    detail: 'Start sandbox container, run env probe' },
    { title: 'Resolve',  detail: 'Fetch Spack/conda-forge recipes, build dep tree' },
    { title: 'Download', detail: 'Download and verify source tarballs' },
    { title: 'Build',    detail: 'Compile each dependency in topological order' },
    { title: 'Validate', detail: 'Cut network, verify offline install works' },
    { title: 'Bundle',   detail: 'Write install.sh, modulefile, manifest, tar.gz' },
  ],
}

// args: { software, version, outputDir, installPrefix, maxRetries, projectDir }
const software     = args.software
const version      = args.version
const outputDir    = args.outputDir    || './bundles'
const installPrefix = args.installPrefix || '$HOME/pkg'
const maxRetries   = args.maxRetries   || 3
const projectDir   = args.projectDir
if (!projectDir) throw new Error('projectDir is required — pass it as an arg or set HPC_BUNDLER_PROJECT_DIR in .claude/settings.json')

const containerName = `lmod-sandbox-${software}-${version.replace(/\./g, '-')}`
const bundleDir     = `${outputDir}/${software}-${version}-bundle`

// ── Phase: Setup ──────────────────────────────────────────────────────────────
phase('Setup')
const setupResult = await agent(
  `Set up the hpc-bundler Docker sandbox for ${software} ${version}.

  Run the following steps in order using the Bash tool:

  1. Ensure the bundle directory exists:
     mkdir -p ${bundleDir}/sources ${bundleDir}/patches

  2. Build the sandbox Docker image (skip if already built):
     docker image inspect hpc-bundler-sandbox:latest > /dev/null 2>&1 || \
       docker build -t hpc-bundler-sandbox:latest ${projectDir}

  3. Remove any leftover container with the same name:
     docker rm -f ${containerName} 2>/dev/null || true

  4. Start the container with the bundle volume (read-write) and Claude credentials (read-only):
     docker run -d --name ${containerName} \
       --volume ${bundleDir}:/bundle \
       --volume ~/.claude:/root/.claude:ro \
       hpc-bundler-sandbox:latest tail -f /dev/null

  5. Run the environment probe:
     cd ${projectDir} && $VIRTUAL_ENV/bin/python -m hpc_bundler.cli.probe ${containerName} ${bundleDir}

  Return the full contents of ${bundleDir}/probe.json so the orchestrator can use it.`,
  { label: 'sandbox-setup', phase: 'Setup' }
)

// ── Retry loop: Resolve → Download → Build → Validate ─────────────────────────
let retryCount = 0
let previousFailure = null
let validationPassed = false

while (retryCount <= maxRetries) {
  if (retryCount > 0) {
    log(`Retry ${retryCount}/${maxRetries} — restoring network and re-resolving deps`)
    await agent(
      `Restore the Docker network for the retry:
       docker network connect bridge ${containerName} 2>/dev/null || true`,
      { label: `restore-network-${retryCount}`, phase: 'Resolve' }
    )
  }

  // ── Phase: Resolve ──────────────────────────────────────────────────────────
  phase('Resolve')
  await agent(
    `You are an expert HPC dependency resolver for AlmaLinux 9.7 (x86_64).

  Target package: ${software} ${version}
  Install prefix pattern: ${installPrefix}/<name>/<version>

  SYSTEM BASELINE — already present on the build host (DO NOT include these in the dep tree):
  ${setupResult}

  ${previousFailure ? `PREVIOUS FAILURE — adjust the dep tree to fix this:
  ${previousFailure}
  ` : ''}

  Your task:
  1. Use WebFetch to retrieve the Spack recipe:
     https://raw.githubusercontent.com/spack/spack/develop/var/spack/repos/builtin/packages/${software.toLowerCase()}/package.py

  2. Use WebFetch to retrieve the conda-forge recipe (both files):
     https://raw.githubusercontent.com/conda-forge/${software.toLowerCase()}-feedstock/main/recipe/meta.yaml
     https://raw.githubusercontent.com/conda-forge/${software.toLowerCase()}-feedstock/main/recipe/build.sh

  3. Parse the recipes to identify ALL build-time dependencies:
     - Extract depends_on() calls from the Spack recipe (translate version ranges like @1.0:2.5 to a single concrete version)
     - Cross-reference with conda-forge meta.yaml requirements
     - Exclude any dependency already satisfied by the system baseline above
     - Resolve transitive dependencies recursively

  4. For each dependency, determine:
     - name, version (concrete, no ranges)
     - source_url (direct download URL for the source tarball)
     - sha256 checksum (find from the recipe or the project's release page)
     - build_system: autotools | cmake | meson | pip | custom
     - configure_flags: any flags needed (e.g. --enable-shared, -DBUILD_SHARED_LIBS=ON)
     - build_order: 1 for leaf deps (no dependencies of their own), increasing toward the target

  5. Write the result as JSON to ${bundleDir}/dep_tree.json with this exact schema:
     {
       "target": "${software}",
       "version": "${version}",
       "dependencies": [
         {
           "name": "string",
           "version": "string",
           "source_url": "string",
           "sha256": "string",
           "file": "sources/<name>-<version>.tar.gz",
           "build_system": "autotools|cmake|meson|pip|custom",
           "configure_flags": [],
           "env_vars": {},
           "patches": [],
           "build_order": 1,
           "recipe_source": "spack|conda-forge|agent-reasoning",
           "is_target": false
         }
       ],
       "warnings": []
     }
     Mark the target package (${software} itself) with "is_target": true and the highest build_order.

  Use the Write tool to write dep_tree.json. Return a summary of what you found.`,
    { label: `dep-resolve-${retryCount}`, phase: 'Resolve' }
  )

  // ── Phase: Download ─────────────────────────────────────────────────────────
  phase('Download')
  const downloadResult = await agent(
    `Download all source tarballs for the ${software} ${version} build.

  Run: cd ${projectDir} && $VIRTUAL_ENV/bin/python -m hpc_bundler.cli.download ${bundleDir}/dep_tree.json

  Report any checksum failures, 404 errors, or missing URLs.
  Return "SUCCESS" or "FAILURE: <details>".`,
    { label: `download-${retryCount}`, phase: 'Download' }
  )

  if (downloadResult.includes('FAILURE')) {
    log(`Download failed: ${downloadResult}`)
    previousFailure = `Download failed: ${downloadResult}`
    retryCount++
    continue
  }

  // ── Phase: Build ────────────────────────────────────────────────────────────
  phase('Build')
  const buildResult = await agent(
    `Run this command to build all dependencies inside the isolated Docker container:

  docker exec ${containerName} claude --dangerously-skip-permissions -p "
  You are a build engineer inside an AlmaLinux 9.7 Docker container.
  Your ONLY job is to build software from source. Do not fetch anything from the internet —
  all source tarballs are already in /bundle/sources/.

  Read /bundle/dep_tree.json for the full dependency list and build each one in ascending build_order.

  For each dependency:
  - Source tarball: /bundle/sources/<name>-<version>.tar.gz
  - Install prefix: /root/pkg/<name>/<version>
  - GCC 14 toolchain is pre-configured on PATH

  Build patterns:
  - autotools: cd /tmp && tar xf /bundle/sources/<tarball> && cd <dir> && ./configure --prefix=/root/pkg/<name>/<ver> <flags> && make -j\$(nproc) && make install
  - cmake:     cd /tmp && tar xf /bundle/sources/<tarball> && cd <dir> && mkdir _build && cd _build && cmake -DCMAKE_INSTALL_PREFIX=/root/pkg/<name>/<ver> <flags> .. && make -j\$(nproc) && make install
  - meson:     cd /tmp && tar xf /bundle/sources/<tarball> && cd <dir> && meson setup _build --prefix=/root/pkg/<name>/<ver> && ninja -C _build && ninja -C _build install
  - pip:       pip install --no-deps --prefix=/root/pkg/<name>/<ver> /bundle/sources/<tarball>

  After each successful package install, append an entry to /bundle/build_log.json:
  { 'package_name': '...', 'package_version': '...', 'commands': [...], 'success': true }

  If a build fails: write /bundle/build_failure.json with the stderr and your suggested fix,
  then exit with the message FAILURE: <package> — <reason>.

  If all builds succeed: write the completed /bundle/build_log.json and reply SUCCESS.
  "

  Report what the container returned. Return "SUCCESS" or "FAILURE: <details>".`,
    { label: `build-${retryCount}`, phase: 'Build' }
  )

  if (buildResult.includes('FAILURE')) {
    log(`Build failed (attempt ${retryCount + 1}): ${buildResult}`)
    previousFailure = buildResult
    retryCount++
    continue
  }

  // ── Phase: Validate ─────────────────────────────────────────────────────────
  phase('Validate')
  const validationResult = await agent(
    `Verify the offline install of ${software} ${version}.

  Step 1 — Cut the network from the host (run this yourself with Bash):
    docker network disconnect bridge ${containerName}

  Step 2 — Confirm the network is cut inside the container:
    docker exec ${containerName} bash --login -c "curl -s --max-time 5 http://1.1.1.1 && echo ONLINE || echo OFFLINE"
    If ONLINE, wait 2 seconds and retry once before failing.

  Step 3 — Run full offline validation inside the container via Claude:
    docker exec ${containerName} claude --dangerously-skip-permissions -p "
    You are verifying an offline install of ${software} ${version} inside a network-isolated container.

    Run these checks and write results to /bundle/validation.json:
    1. Confirm no network: curl -s --max-time 3 http://1.1.1.1 && echo ONLINE || echo OFFLINE  (must be OFFLINE)
    2. Binary exists: ls /root/pkg/${software}/${version}/bin/
    3. No missing shared libs: find /root/pkg/${software}/${version} -name '*.so*' | head -1 | xargs -r ldd 2>&1 | grep 'not found' | wc -l  (must be 0)
    4. Version runs: /root/pkg/${software}/${version}/bin/${software} --version 2>&1 | head -3
    5. Module load: module use /root/modulefiles && module load ${software}/${version} && echo MODULE_OK

    Write /bundle/validation.json: { success: bool, checks: [...], summary: string }
    Reply PASSED if checks 1-4 all pass, FAILED: <reason> otherwise.
    "

  Report what the container returned. Return "PASSED" or "FAILED: <details>".`,
    { label: `validate-${retryCount}`, phase: 'Validate' }
  )

  if (validationResult.includes('PASSED')) {
    log('Offline validation passed!')
    validationPassed = true
    break
  }

  log(`Validation failed (attempt ${retryCount + 1}): ${validationResult}`)
  previousFailure = `Offline validation failed: ${validationResult}`
  retryCount++
}

if (!validationPassed) {
  await agent(
    `Clean up the Docker container: docker stop ${containerName} && docker rm ${containerName}`,
    { label: 'cleanup-on-failure', phase: 'Bundle' }
  )
  throw new Error(`Failed to install ${software} ${version} after ${maxRetries} retries. Last error: ${previousFailure}`)
}

// ── Phase: Bundle ──────────────────────────────────────────────────────────────
phase('Bundle')
const tarballPath = await agent(
  `Assemble the final offline bundle for ${software} ${version}.

  Run: cd ${projectDir} && $VIRTUAL_ENV/bin/python -m hpc_bundler.cli.assemble ${bundleDir} ${outputDir}

  This will:
  - Render install.sh from the build log (exact commands, not regenerated)
  - Render the Lua modulefile
  - Write manifest.json and README.md
  - Create ${outputDir}/${software}-${version}-bundle.tar.gz

  Then clean up the Docker container:
    docker stop ${containerName} && docker rm ${containerName}

  Return the path to the final tarball.`,
  { label: 'assemble-bundle', phase: 'Bundle' }
)

log(`Bundle ready: ${tarballPath}`)
return `Bundle created: ${outputDir}/${software}-${version}-bundle.tar.gz`
