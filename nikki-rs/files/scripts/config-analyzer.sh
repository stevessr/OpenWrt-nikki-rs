#!/bin/sh
# Non-sensitive configuration impact report for a proposed module edit.
# Reads the last generated base snapshot; never writes the active profile.
# Usage: config-analyzer.sh BASE MODULE CANDIDATE
set -eu

ROOT="${NIKKI_HOME_DIR:-/etc/nikki-rs}"
COMPOSER="${NIKKI_COMPOSER:-$ROOT/scripts/override-manager.sh}"

fail() { printf 'config-analyzer: %s\n' "$*" >&2; exit 1; }
[ "$#" -eq 3 ] || fail 'Usage: config-analyzer.sh BASE MODULE CANDIDATE'
base="$1"
module="$2"
candidate="$3"
case "$module" in general|dns|proxy-groups|rules|tun|sniffer|custom) ;; *) fail 'Unknown config module' ;; esac
[ -f "$base" ] && [ ! -L "$base" ] || fail 'Base profile missing or unsafe'
[ -f "$candidate" ] && [ ! -L "$candidate" ] || fail 'Candidate missing or unsafe'
[ "$(wc -c < "$candidate")" -le 262144 ] || fail 'Candidate exceeds 256 KiB'

work="$(mktemp -d /tmp/nikki-rs-analyze.XXXXXX)" || fail 'Unable to allocate temporary files'
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Compare saved overrides with the proposed replacement using the same
# eBPF/TUN-aware merger that production startup, preview and preflight use.
sh "$COMPOSER" preview "$base" > "$work/before.yaml" || fail 'Saved configuration cannot be merged'
sh "$COMPOSER" preview "$base" "$module" "$candidate" > "$work/after.yaml" ||
    fail 'Proposed configuration cannot be merged'
[ "$(wc -c < "$work/before.yaml")" -le 4194304 ] || fail 'Saved profile too large'
[ "$(wc -c < "$work/after.yaml")" -le 4194304 ] || fail 'Proposed profile too large'

# Compare canonical JSON *values*, not YAML nodes: styles, comments and
# internal metadata differ between copied profiles and yq's merged output.
# Neither JSON documents nor their checksums leave this temporary directory.
yq -r 'keys | .[]' "$work/before.yaml" "$work/after.yaml" |
    LC_ALL=C sort -u > "$work/sections"
{
    printf '['
    first=1
    while IFS= read -r key; do
        current="$(KEY="$key" yq -o=json -I=0 '.[strenv(KEY)]' "$work/before.yaml" | sha256sum | cut -d ' ' -f 1)"
        proposed="$(KEY="$key" yq -o=json -I=0 '.[strenv(KEY)]' "$work/after.yaml" | sha256sum | cut -d ' ' -f 1)"
        if [ "$current" != "$proposed" ]; then
            [ "$first" = 1 ] || printf ','
            KEY="$key" yq -n -o=json -I=0 'strenv(KEY)' | tr -d '\n'
            first=0
        fi
    done < "$work/sections"
    printf ']\n'
} > "$work/changes.json"
export NIKKI_CHANGES_FILE="$work/changes.json"

# Do not expose URLs, passwords, proxy names or rule bodies. Only top-level
# changed field names and numerical/boolean diagnostics are returned.
yq -M -o=json eval-all '
  . as $item ireduce ([]; . + [$item]) |
  .[0] as $old | .[1] as $new |
  {
    "changed_sections": load(strenv(NIKKI_CHANGES_FILE)),
    "before": {
      "rules": ($old.rules // [] | length),
      "proxies": ($old.proxies // [] | length),
      "groups": ($old."proxy-groups" // [] | length),
      "rule_providers": ($old."rule-providers" // {} | length),
      "ebpf": ($old.ebpf.enable == true),
      "tun": ($old.tun.enable == true)
    },
    "after": {
      "rules": ($new.rules // [] | length),
      "proxies": ($new.proxies // [] | length),
      "groups": ($new."proxy-groups" // [] | length),
      "rule_providers": ($new."rule-providers" // {} | length),
      "ebpf": ($new.ebpf.enable == true),
      "tun": ($new.tun.enable == true),
      "duplicate_rules": (($new.rules // [] | length) -
        ($new.rules // [] | unique | length)),
      "duplicate_proxy_names": (($new.proxies // [] | map(.name) | length) -
        ($new.proxies // [] | map(.name) | unique | length)),
      "duplicate_group_names": (($new."proxy-groups" // [] | map(.name) | length) -
        ($new."proxy-groups" // [] | map(.name) | unique | length)),
      "tun_listeners": ([$new.listeners // [] | .[] | select(.type == "tun")] | length),
      "dns": ($new.dns.enable == true),
      "dns2": ($new.dns2.enable == true)
    }
  }
' "$work/before.yaml" "$work/after.yaml" ||
    fail 'Unable to generate safe impact report'
