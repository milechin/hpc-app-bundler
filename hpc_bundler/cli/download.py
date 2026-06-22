"""
Usage: python -m hpc_bundler.cli.download <dep_tree.json>

Downloads all source tarballs listed in dep_tree.json into the bundle's
sources/ directory and verifies sha256 checksums. Writes download_result.json
to the same directory as dep_tree.json.
"""
import json
import sys
from pathlib import Path

from ..bundle import download_sources


def main():
    if len(sys.argv) != 2:
        print("Usage: download <dep_tree.json>", file=sys.stderr)
        sys.exit(1)

    dep_tree_path = sys.argv[1]
    bundle_dir = str(Path(dep_tree_path).parent)

    try:
        result = download_sources(dep_tree_path, bundle_dir)
        print(json.dumps(result, indent=2))
    except Exception as e:
        error = {"success": False, "error": str(e)}
        print(json.dumps(error, indent=2))
        sys.exit(1)


if __name__ == "__main__":
    main()
