#!/usr/bin/env bash
set -euo pipefail

hub_url="${HUB_URL:-https://wuxianpihub.webefficacy.com}"
hub_url="${hub_url%/}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required command not found: $1" >&2
    exit 2
  }
}

require_command curl
require_command python3

json_get() {
  local expression="$1"
  python3 -c "import json,sys; value=json.load(sys.stdin)$expression; print('' if value is None else value)"
}

request_json() {
  local method="$1"
  local url="$2"
  local token="${3:-}"
  local body="${4:-}"
  local output status
  output="$(mktemp)"
  if [[ -n "$token" && -n "$body" ]]; then
    status="$(curl -sS -o "$output" -w '%{http_code}' -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data "$body" "$url")"
  elif [[ -n "$token" ]]; then
    status="$(curl -sS -o "$output" -w '%{http_code}' -X "$method" -H "Authorization: Bearer $token" "$url")"
  else
    status="$(curl -sS -o "$output" -w '%{http_code}' -X "$method" "$url")"
  fi
  if [[ "$status" -lt 200 || "$status" -ge 300 ]]; then
    echo "HTTP $status from $method $url" >&2
    cat "$output" >&2
    rm -f "$output"
    return 1
  fi
  cat "$output"
  rm -f "$output"
}

health="$(request_json GET "$hub_url/health")"
[[ "$(json_get "['status']" <<<"$health")" == "ok" ]]
catalog="$(request_json GET "$hub_url/api/v1/packages")"
python3 -c "import json,sys; body=json.load(sys.stdin); assert isinstance(body.get('packages'), list)" <<<"$catalog"
html="$(curl -fsS "$hub_url/")"
grep -q "WuxianPi Hub" <<<"$html"
echo "Public Hub health, catalog, and UI checks passed."

if [[ -z "${HUB_PUBLISHER_TOKEN:-}" || -z "${HUB_ADMIN_TOKEN:-}" || -z "${PACKAGE_REPOSITORY:-}" || -z "${PACKAGE_REF:-}" ]]; then
  echo "Authenticated end-to-end flow skipped because credentials or Package fixture settings were not provided."
  exit 0
fi
if [[ "${HUB_ALLOW_PERSISTENT_MUTATION:-}" != "1" ]]; then
  echo "Authenticated mutation skipped. Set HUB_ALLOW_PERSISTENT_MUTATION=1 only for an isolated Hub or an intentionally persistent production Release."
  exit 0
fi

require_command git

expected_commit="${PACKAGE_EXPECTED_COMMIT:-}"
if [[ -z "$expected_commit" ]]; then
  checkout="$(mktemp -d)"
  trap 'rm -rf "$checkout"' EXIT
  git -C "$checkout" init --quiet
  git -C "$checkout" fetch --quiet --depth=1 --no-tags "$PACKAGE_REPOSITORY" "$PACKAGE_REF"
  expected_commit="$(git -C "$checkout" rev-parse 'FETCH_HEAD^{commit}')"
  rm -rf "$checkout"
fi
if [[ ! "$expected_commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected commit is not a full Git commit: $expected_commit" >&2
  exit 2
fi

validate_install_plan() {
  local plan="$1"
  local expected_repository="$2"
  local expected_mirror="$3"
  local expected="$4"
  PLAN_JSON="$plan" python3 - "$expected_repository" "$expected_mirror" "$expected" <<'PY'
import json, os, sys
repository, mirror, expected = sys.argv[1:]
plan = json.loads(os.environ["PLAN_JSON"])
assert plan["approvedCommit"] == expected
sources = plan["gitSources"]
assert sources[0]["kind"] == "github"
assert sources[0]["url"].rstrip("/") == repository.rstrip("/")
if mirror:
    assert any(item["kind"] == "mirror" and item["url"] == mirror for item in sources)
PY
}

if [[ -n "${PACKAGE_ID:-}" ]]; then
  existing_releases="$(curl -fsS "$hub_url/api/v1/packages/$PACKAGE_ID/releases" 2>/dev/null || true)"
  existing_release_id="$(EXISTING_RELEASES="$existing_releases" python3 - "$expected_commit" <<'PY'
import json, os, sys
try:
    releases = json.loads(os.environ.get("EXISTING_RELEASES", "{}" )).get("releases", [])
except json.JSONDecodeError:
    releases = []
expected = sys.argv[1]
print(next((item["releaseId"] for item in releases if item.get("approvedCommit") == expected and item.get("status") == "approved"), ""))
PY
)"
  if [[ -n "$existing_release_id" ]]; then
    plan="$(request_json GET "$hub_url/api/v1/packages/$PACKAGE_ID/install-plan?releaseId=$existing_release_id")"
    validate_install_plan "$plan" "$PACKAGE_REPOSITORY" "${PACKAGE_MIRROR_URL:-}" "$expected_commit"
    echo "Existing immutable Release passed for $PACKAGE_ID at exact commit $expected_commit."
    exit 0
  fi
fi

payload="$(python3 - "$PACKAGE_REPOSITORY" "$PACKAGE_REF" "${PACKAGE_MIRROR_URL:-}" <<'PY'
import json, sys
repository, ref, mirror = sys.argv[1:]
print(json.dumps({
    "repositoryUrl": repository,
    "ref": ref,
    "mirrorUrls": [mirror] if mirror else [],
    "metadata": {"links": [], "screenshots": []},
}, separators=(",", ":")))
PY
)"

submission_id=""
release_id=""
mutation_completed=false
cleanup_failed_mutation() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && "$mutation_completed" != true ]]; then
    if [[ -n "$release_id" ]]; then
      curl -sS -X POST \
        -H "Authorization: Bearer $HUB_ADMIN_TOKEN" \
        -H 'Content-Type: application/json' \
        --data '{"reason":"Automated E2E failed after approval; release revoked."}' \
        "$hub_url/api/v1/admin/releases/$release_id/revoke" >/dev/null 2>&1 || true
    elif [[ -n "$submission_id" ]]; then
      curl -sS -X POST \
        -H "Authorization: Bearer $HUB_ADMIN_TOKEN" \
        -H 'Content-Type: application/json' \
        --data '{"reason":"Automated E2E did not complete; submission rejected."}' \
        "$hub_url/api/v1/admin/submissions/$submission_id/reject" >/dev/null 2>&1 || true
    fi
  fi
  exit "$status"
}
trap cleanup_failed_mutation EXIT

created="$(request_json POST "$hub_url/api/v1/publisher/submissions" "$HUB_PUBLISHER_TOKEN" "$payload")"
submission_id="$(json_get "['submission']['submissionId']" <<<"$created")"
[[ -n "$submission_id" ]]

submission=""
for _ in $(seq 1 90); do
  submission="$(request_json GET "$hub_url/api/v1/publisher/submissions/$submission_id" "$HUB_PUBLISHER_TOKEN")"
  status="$(json_get "['submission']['status']" <<<"$submission")"
  case "$status" in
    awaiting_review) break ;;
    failed|rejected)
      echo "Package verification ended in $status" >&2
      echo "$submission" >&2
      exit 1
      ;;
  esac
  sleep 2
done

status="$(json_get "['submission']['status']" <<<"$submission")"
[[ "$status" == "awaiting_review" ]]
resolved_commit="$(json_get "['submission']['resolvedCommit']" <<<"$submission")"
[[ "$resolved_commit" == "$expected_commit" ]]
package_id="$(json_get "['submission']['packageId']" <<<"$submission")"
[[ -n "$package_id" ]]

approval="$(request_json POST "$hub_url/api/v1/admin/submissions/$submission_id/approve" "$HUB_ADMIN_TOKEN" '{"notes":"Production deployment end-to-end verification passed."}')"
approved_commit="$(json_get "['approvedCommit']" <<<"$approval")"
release_id="$(json_get "['releaseId']" <<<"$approval")"
[[ "$approved_commit" == "$expected_commit" ]]

plan="$(request_json GET "$hub_url/api/v1/packages/$package_id/install-plan?releaseId=$release_id")"
plan_commit="$(json_get "['approvedCommit']" <<<"$plan")"
[[ "$plan_commit" == "$expected_commit" ]]
validate_install_plan "$plan" "$PACKAGE_REPOSITORY" "${PACKAGE_MIRROR_URL:-}" "$expected_commit"

if [[ -n "${HUB_COMPOSE_DIR:-}" ]]; then
  docker compose -f "$HUB_COMPOSE_DIR/docker-compose.yml" --project-directory "$HUB_COMPOSE_DIR" restart hub >/dev/null
  for _ in $(seq 1 60); do
    if curl -fsS "$hub_url/health" >/dev/null; then break; fi
    sleep 2
  done
  persisted="$(request_json GET "$hub_url/api/v1/packages/$package_id/install-plan?releaseId=$release_id")"
  [[ "$(json_get "['approvedCommit']" <<<"$persisted")" == "$expected_commit" ]]
fi

mutation_completed=true
trap - EXIT
echo "End-to-end flow passed for $package_id at exact commit $expected_commit."
