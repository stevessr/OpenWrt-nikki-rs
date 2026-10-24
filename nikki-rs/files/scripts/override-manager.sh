#!/bin/sh
# Compose advanced YAML overrides without editing subscription originals.
# Usage: override-manager.sh {check|preview|apply|inspect|test} BASE [OUTPUT|MODULE CANDIDATE]
set -eu

HOME_DIR="${NIKKI_HOME_DIR:-/etc/nikki-rs}"
OVERRIDES="$HOME_DIR/overrides"
MAX_MODULE=262144
MAX_PREVIEW=2097152
MODULES="general dns dns2 proxy-groups proxy-providers rule-providers rules listeners inbound-providers tun sniffer hosts geodata custom"

fail() { echo "override-manager: $*" >&2; exit 1; }
valid_module() {
    case " $MODULES " in *" $1 "*) return 0 ;; *) fail "Unknown module: $1" ;; esac
}
check_yaml() {
    [ -f "$1" ] && [ ! -L "$1" ] || fail "Missing or unsafe YAML file"
    [ "$(wc -c < "$1")" -le "$2" ] || fail "YAML exceeds size limit"
    yq -e 'tag == "!!map"' "$1" >/dev/null 2>&1 || fail "Expected a YAML mapping: $1"
}
operation="${1:-}"
base="${2:-}"
[ -n "$base" ] || fail "A base configuration path is required"
case "$base" in /*) ;; *) fail "Base path must be absolute" ;; esac
[ -f "$base" ] || fail "Base configuration not found"
check_yaml "$base" "$MAX_PREVIEW"

module=''
candidate=''
output=''
case "$operation" in
    check|preview|inspect|test)
        [ "$#" -eq 2 ] || [ "$#" -eq 4 ] || fail "Usage: $operation BASE [MODULE CANDIDATE]"
        if [ "$#" -eq 4 ]; then
            module="$3"
            valid_module "$module"
            candidate="$4"
            case "$candidate" in /tmp/nikki-rs-edit.*|/var/run/nikki-rs/*) ;; *) fail "Unexpected staging path" ;; esac
            check_yaml "$candidate" "$MAX_MODULE"
        fi
        ;;
    apply)
        [ "$#" -eq 3 ] || fail "Usage: apply BASE OUTPUT"
        output="$3"
        case "$output" in /*) ;; *) fail "Output path must be absolute" ;; esac
        [ "$base" != "$output" ] || fail "Output must differ from the source"
        ;;
    *) fail "Unknown command" ;;
esac

# The eBPF switch in UCI wins over imported profiles and override files.
# During offline tests NIKKI_EBPF_ENABLED can override the UCI lookup.
ebpf_requested="${NIKKI_EBPF_ENABLED:-}"
if [ -z "$ebpf_requested" ] && command -v uci >/dev/null 2>&1; then
    ebpf_requested="$(uci -q get nikki-rs.ebpf.enabled 2>/dev/null || true)"
fi
case "$ebpf_requested" in 1) ;; *) ebpf_requested=0 ;; esac
export NIKKI_EBPF_FORCE="$ebpf_requested"

set -- "$base"
count=0
for name in $MODULES; do
    file="$OVERRIDES/$name.yaml"
    if [ "$name" = "$module" ]; then file="$candidate"; fi
    [ -f "$file" ] || continue
    check_yaml "$file" "$MAX_MODULE"
    set -- "$@" "$file"
    count=$((count + 1))
done

# nikki-* arrays prepend to Clash arrays; other YAML fields override by
# deep-map merge. A pure function is used for checks, preview and startup.
merge_yaml() {
    yq -M eval-all '
      . as $item ireduce ({}; . as $acc |
        ($acc * $item) |
        ."nikki-rules" = (($acc."nikki-rules" // []) + ($item."nikki-rules" // [])) |
        ."nikki-proxies" = (($acc."nikki-proxies" // []) + ($item."nikki-proxies" // [])) |
        ."nikki-proxy-groups" = (($acc."nikki-proxy-groups" // []) + ($item."nikki-proxy-groups" // [])) |
        ."nikki-listeners" = (($acc."nikki-listeners" // []) + ($item."nikki-listeners" // []))
      ) |
      .rules = ((."nikki-rules" // []) + (.rules // [])) |
      .proxies = ((."nikki-proxies" // []) + (.proxies // [])) |
      .proxy-groups = ((."nikki-proxy-groups" // []) + (.proxy-groups // [])) |
      .listeners = ((."nikki-listeners" // []) + (.listeners // [])) |
      del(."nikki-rules", ."nikki-proxies", ."nikki-proxy-groups", ."nikki-listeners") |
      (. | select(strenv(NIKKI_EBPF_FORCE) == "1") | .ebpf.enable) = true |
      (. | select(.ebpf.enable == true) | .tun.enable) = false |
      (. | select(.ebpf.enable == true) | .tun."enable-tcp") = false |
      (. | select(.ebpf.enable == true and (.listeners | tag) == "!!seq") | .listeners) |=
        map(select(.type != "tun"))
    ' "$@"
}
inspect_yaml() {
    # Never print servers, passwords, proxy names or rules to the diagnostic RPC.
    yq -M -p yaml -o json '{
      "mode": (.mode // ""),
      "dns_mode": (.dns."enhanced-mode" // ""),
      "rules": (.rules // [] | length),
      "proxies": (.proxies // [] | length),
      "groups": (."proxy-groups" // [] | length),
      "duplicate_rules": ((.rules // [] | length) - (.rules // [] | unique | length))
    }' "$1"
}
# Even without overlay modules, a core-only profile may have TUN enabled
# while its own eBPF section (or the LuCI eBPF switch) is active.
config_has_ebpf=0
if yq -e '.ebpf.enable == true' "$base" >/dev/null 2>&1; then
    config_has_ebpf=1
fi
if [ "$count" -eq 0 ] && [ "$ebpf_requested" != 1 ] && [ "$config_has_ebpf" != 1 ]; then
    case "$operation" in
        apply) cp "$base" "$output"; exit 0 ;;
        preview) cat "$base"; exit 0 ;;
        check) exit 0 ;;
        inspect) inspect_yaml "$base"; exit 0 ;;
    esac
fi
case "$operation" in
    check) merge_yaml "$@" >/dev/null || fail "Overlay merge failed" ;;
    preview) merge_yaml "$@" || fail "Overlay preview failed" ;;
    apply) merge_yaml "$@" > "$output" || fail "Overlay merge failed" ;;
    test)
        tmpdir="$(mktemp -d /tmp/nikki-rs-core-test.XXXXXX)"
        trap 'rm -rf "$tmpdir"' EXIT INT TERM
        merge_yaml "$@" > "$tmpdir/config.yaml" || fail "Candidate merge failed"
        core="${NIKKI_TEST_CORE:-/usr/bin/clash-rs}"
        [ ! -x /etc/nikki-rs/core/clash-rs ] || core=/etc/nikki-rs/core/clash-rs
        [ -x "$core" ] || fail "clash-rs executable is missing"
        if command -v timeout >/dev/null 2>&1; then
            timeout 35 "$core" -d "$tmpdir" -t
        else
            "$core" -d "$tmpdir" -t
        fi
        ;;
    inspect)
        stage="$(mktemp /tmp/nikki-rs-inspect.XXXXXX)"
        trap 'rm -f "$stage"' EXIT INT TERM
        merge_yaml "$@" > "$stage" || fail "Overlay merge failed"
        inspect_yaml "$stage"
        ;;
esac
