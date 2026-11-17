#!/bin/sh
# Resolve the internal target only after all groups have been merged.
set -eu
export SMART_TARGET=__NIKKI_SMART__
stage=$(mktemp /tmp/nikki-rule-targets.XXXXXX)
trap 'rm -f "$stage"' EXIT INT TERM
cat > "$stage"
yq -e 'tag == "!!map"' "$stage" >/dev/null || exit 1
smart_count=$(yq -r '[ (.rules // [])[] | split(",") | select(contains([strenv(SMART_TARGET)])) ] | length' "$stage")
[ "$smart_count" -gt 0 ] || { cat "$stage"; exit 0; }
select_count=$(yq -r '[(."proxy-groups" // [])[] | select(.type == "select")] | length' "$stage")
[ "$select_count" -gt 0 ] || { echo "Smart rule target requires at least one select proxy group" >&2; exit 1; }
# Count the listed selectable entries. Provider-backed groups count each use
# entry; their live remote node counts are not available during offline merge.
yq -M '([."proxy-groups"[] | select(.type == "select") | [.name, ((.proxies // [] | length) + (.use // [] | length))]] | sort_by(.[1]) | .[-1][0]) as $smart_group |
    .rules |= map(split(",") | map(select(. != "")) | map(sub("^" + strenv(SMART_TARGET) + "$"; $smart_group)) | join(","))' "$stage"
