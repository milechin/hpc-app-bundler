#!/usr/bin/env bash
# Launch the hpc-bundler Docker sandbox and drop into an isolated Claude Code session.
#
# Usage:
#   ./launch-sandbox.sh                        # bundles go to ./bundles/
#   ./launch-sandbox.sh /path/to/output        # bundles go to the specified directory
#
# What this does:
#   1. Builds the sandbox image if it isn't already built
#   2. Starts a container with:
#        /bundle                <- your bundle output directory (read-write)
#   3. Drops you into Claude Code inside the container with --dangerously-skip-permissions
#      Run /login inside the session if prompted to authenticate.
#
# Inside the session, run:
#   /hpc-bundle <software> <version>
#
# Everything Claude does stays inside the container. Results appear in your bundle directory.

set -euo pipefail

BUNDLE_DIR="${1:-./bundles}"
IMAGE="hpc-bundler-sandbox:v3"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve to absolute path so the volume mount works from any cwd
BUNDLE_DIR="$(mkdir -p "$BUNDLE_DIR" && cd "$BUNDLE_DIR" && pwd)"

echo "==> Bundle output directory: $BUNDLE_DIR"

# Build image if not present
if ! docker image inspect "$IMAGE" > /dev/null 2>&1; then
    echo "==> Building sandbox image (first run, ~25-30 minutes)..."
    docker build -t "$IMAGE" "$SCRIPT_DIR"
else
    echo "==> Sandbox image already built."
fi

echo "==> Launching isolated Claude Code session inside container..."
echo "    If prompted, run /login to authenticate."
echo "    Type /hpc-bundle <software> <version> to start a build."
echo ""

docker run --rm -it \
    --memory="12g" \
    --cpus="$(nproc)" \
    --volume "${BUNDLE_DIR}:/bundle" \
    --volume "${SCRIPT_DIR}/.claude/workflows:/workspace/.claude/workflows:ro" \
    --volume "${SCRIPT_DIR}/.claude/commands:/workspace/.claude/commands:ro" \
    --volume "${SCRIPT_DIR}/hpc_bundler:/workspace/hpc_bundler:ro" \
    "$IMAGE" \
    -c "claude --dangerously-skip-permissions"
