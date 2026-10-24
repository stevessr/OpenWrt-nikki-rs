#!/bin/sh
# Compose advanced YAML overrides without editing subscription originals.
# Usage: override-manager.sh {check|preview|apply|inspect} BASE [OUTPUT|MODULE CANDIDATE]
set -eu

HOME_DIR="${NIKKI_HOME_DIR:-/etc/nikki-rs}"
OVERRIDES="$HOME_DIR/overrides"
MAX_MODULE=262144
MAX_PREVIEW=2097152
MODULES="general dns proxy-groups rules tun sniffer custom"

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
    check|preview|inspect)
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
        ."nikki-proxy-groups" = (($acc."nikki-proxy-groups" // []) + ($item."nikki-proxy-groups" // []))
      ) |
      .rules = ((."nikki-rules" // []) + (.rules // [])) |
      .proxies = ((."nikki-proxies" // []) + (.proxies // [])) |
      .proxy-groups = ((."nikki-proxy-groups" // []) + (.proxy-groups // [])) |
      del(."nikki-rules", ."nikki-proxies", ."nikki-proxy-groups")
    ' "$@"
}
inspect_yaml() {
    # Never print servers, passwords, proxy names or rules to the diagnostic RPC.
    yq -M -p yaml -o json '{
      mode: (.mode // ""),
      dns_mode: (.dns."enhanced-mode" // ""),
      rules: (.rules // [] | length),
      proxies: (.proxies // [] | length),
      groups: (."proxy-groups" // [] | length),
      duplicate_rules: ((.rules // [] | length) - (.rules // [] | unique | length))
    }' "$1"
}
if [ "$count" -eq 0 ]; then
    case "$operation" in
        apply) cp "$base" "$output" ;;
        preview) cat "$base" ;;
        check) : ;;
        inspect) inspect_yaml "$base" ;;
    esac
    exit 0
fi
case "$operation" in
    check) merge_yaml "$@" >/dev/null || fail "Overlay merge failed" ;;
    preview) merge_yaml "$@" || fail "Overlay preview failed" ;;
    apply) merge_yaml "$@" > "$output" || fail "Overlay merge failed" ;;
    inspect)
        stage="$(mktemp /tmp/nikki-rs-inspect.XXXXXX)"
        trap 'rm -f "$stage"' EXIT INT TERM
        merge_yaml "$@" > "$stage" || fail "Overlay merge failed"
        inspect_yaml "$stage"
        ;;
esac
