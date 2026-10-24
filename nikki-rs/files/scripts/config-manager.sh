#!/bin/sh
# Safe, versioned edits for the files exposed by the LuCI editor.
set -eu
BASE="${NIKKI_CONFIG_BASE:-/etc/nikki-rs}"
BACKUPS="$BASE/backups"
MAX_SIZE=2097152

fail() { echo "$*" >&2; exit 1; }
valid_path() {
    path="$1"
    case "$path" in
        "$BASE"/profiles/*.yaml|"$BASE"/profiles/*.yml|\
        "$BASE"/subscriptions/*.yaml|"$BASE"/subscriptions/*.yml|\
        "$BASE"/mixin.yaml|"$BASE"/run/config.yaml|\
        "$BASE"/dns/black_filter|"$BASE"/dns/fake_ip_filter|"$BASE"/dns/fallback_filter|\
        "$BASE"/nftables/proxy_whitelist.txt|"$BASE"/nftables/proxy_whitelist6.txt) ;;
        *) fail "File is not managed by the editor" ;;
    esac
    relative="${path#"$BASE"/}"
    case "$relative" in *..*|*[!a-zA-Z0-9/_.-]*|/*|*//* ) fail "Invalid file name" ;; esac
    # Only the expected one-level named profile or subscription is allowed.
    case "$relative" in
        profiles/*|subscriptions/*)
            tail_part="${relative#*/}"
            case "$tail_part" in */*|'') fail "Nested paths are not supported" ;; esac ;;
    esac
}
backup_dir() {
    relative="${1#"$BASE"/}"
    printf '%s/%s\n' "$BACKUPS" "$(printf '%s' "$relative" | tr / _)"
}
check() {
    file="$1"
    [ -f "$file" ] || fail "Candidate is missing"
    bytes="$(wc -c < "$file")"
    [ "$bytes" -le "$MAX_SIZE" ] || fail "Configuration is larger than 2 MiB"
    case "$path" in
        *.yaml|*.yml)
            yq -M -e 'tag == "!!map"' "$file" >/dev/null 2>&1 || fail "Invalid YAML: top-level mapping required"
            ;;
    esac
}
save() {
    candidate="$1"
    check "$candidate"
    parent="$(dirname "$path")"
    [ -d "$parent" ] || fail "Target directory does not exist"
    dir="$(backup_dir "$path")"
    mkdir -p "$dir"
    if [ -f "$path" ]; then
        archived="$(mktemp "$dir/$(date +%Y%m%dT%H%M%S).XXXXXX")"
        cp -p "$path" "$archived" || { rm -f "$archived"; fail "Backup failed"; }
    fi
    pending="$(mktemp "$parent/.nikki-rs-edit.XXXXXX")"
    trap 'rm -f "$pending"' EXIT
    cp "$candidate" "$pending"
    chmod 600 "$pending"
    mv -f "$pending" "$path"
    trap - EXIT
    ls -1t "$dir" | sed -n '11,$p' | while IFS= read -r old; do rm -f "$dir/$old"; done
}
command="${1:-}"
path="${2:-}"
valid_path "$path"
case "$command" in
    validate) [ "$#" -eq 3 ] || fail "Usage: validate PATH CANDIDATE"; check "$3"; echo "OK" ;;
    save) [ "$#" -eq 3 ] || fail "Usage: save PATH CANDIDATE"; save "$3"; echo "Saved" ;;
    backups)
        dir="$(backup_dir "$path")"
        [ ! -d "$dir" ] || ls -1t "$dir" | head -n 10
        ;;
    restore)
        [ "$#" -eq 3 ] || fail "Usage: restore PATH BACKUP"
        case "$3" in *[!a-zA-Z0-9._-]*|'') fail "Invalid backup identifier" ;; esac
        saved="$(backup_dir "$path")/$3"
        [ -f "$saved" ] || fail "Backup not found"
        save "$saved"
        echo "Restored"
        ;;
    *) fail "Unknown config-manager operation" ;;
esac
