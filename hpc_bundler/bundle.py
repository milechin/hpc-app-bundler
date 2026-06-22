import hashlib
import json
import tarfile
from pathlib import Path

import requests


def download_sources(dep_tree_path: str, bundle_dir: str) -> dict:
    bundle = Path(bundle_dir)
    sources_dir = bundle / "sources"
    sources_dir.mkdir(parents=True, exist_ok=True)

    with open(dep_tree_path) as f:
        dep_tree = json.load(f)

    results = []
    for dep in dep_tree.get("dependencies", []):
        dest = bundle / dep["file"]
        dest.parent.mkdir(parents=True, exist_ok=True)

        if dest.exists():
            actual = _sha256(dest)
            if actual == dep["sha256"]:
                results.append({"name": dep["name"], "status": "cached", "path": str(dest)})
                continue
            dest.unlink()

        _download(dep["source_url"], dest)
        actual = _sha256(dest)
        if dep["sha256"] and actual != dep["sha256"]:
            raise ValueError(
                f"Checksum mismatch for {dep['name']}: expected {dep['sha256']}, got {actual}"
            )
        results.append({"name": dep["name"], "status": "downloaded", "path": str(dest)})

    result = {"downloaded": results, "bundle_dir": str(bundle)}
    (bundle / "download_result.json").write_text(json.dumps(result, indent=2))
    return result


def create_bundle_tarball(bundle_dir: str, output_dir: str) -> str:
    bundle = Path(bundle_dir)
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)

    # derive name from directory name: <software>-<version>-bundle
    dir_name = bundle.name
    tarball = output / f"{dir_name}.tar.gz"

    with tarfile.open(tarball, "w:gz") as tar:
        tar.add(bundle, arcname=dir_name)

    return str(tarball)


def verify_checksum(path: str, expected_sha256: str) -> bool:
    return _sha256(Path(path)) == expected_sha256


def _download(url: str, dest: Path):
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(65536):
                f.write(chunk)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()
