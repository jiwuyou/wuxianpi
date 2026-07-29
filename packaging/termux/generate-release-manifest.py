#!/usr/bin/env python3
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path


def artifact(path: Path) -> dict[str, object]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
    return {
        "file": path.name,
        "url": path.name,
        "size": size,
        "sha256": digest.hexdigest(),
    }


def released_at() -> str:
    epoch = os.environ.get("SOURCE_DATE_EPOCH")
    moment = (
        datetime.datetime.fromtimestamp(int(epoch), datetime.timezone.utc)
        if epoch is not None
        else datetime.datetime.now(datetime.timezone.utc)
    )
    return moment.isoformat().replace("+00:00", "Z")


parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True, type=Path)
parser.add_argument("--version", required=True)
parser.add_argument("--channel", required=True)
parser.add_argument("--min-host-version", required=True, type=int)
parser.add_argument("--web-version", required=True)
parser.add_argument("--runtime-version", required=True)
parser.add_argument("--base-version", required=True)
parser.add_argument("--web", required=True, type=Path)
parser.add_argument("--runtime", required=True, type=Path)
parser.add_argument("--base", required=True, type=Path)
parser.add_argument("--install-arm64", required=True, type=Path)
args = parser.parse_args()

manifest = {
    "schemaVersion": 1,
    "product": "wuxianpi",
    "version": args.version,
    "channel": args.channel,
    "releasedAt": released_at(),
    "minHostVersion": args.min_host_version,
    "hostContractVersion": 1,
    "protocol": {"name": "wuxianpi-sdk-v1", "version": 2},
    "service": {
        "id": "pi-agent",
        "origin": "http://127.0.0.1:8765",
        "healthPath": "/health",
        "uiMetadataPath": "/v1/ui/metadata",
        "websocketPath": "/v1/ws",
        "webApiBasePath": "/api/web/v1",
    },
    "versions": {
        "web": args.web_version,
        "runtime": args.runtime_version,
        "base": args.base_version,
    },
    "artifacts": {
        "web": artifact(args.web),
        "runtime": artifact(args.runtime),
        "base": artifact(args.base),
        "install-arm64": artifact(args.install_arm64),
    },
}

args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

