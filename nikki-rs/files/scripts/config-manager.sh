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
        "$BASE"/mixin.yaml|"$BASE"/run/config.yaml|"$BASE"/overrides/*.yaml|\
        "$BASE"/dns/black_filter|"$BASE"/dns/fake_ip_filter|"$BASE"/dns/fallback_filter|\
        "$BASE"/nftables/proxy_whitelist.txt|"$BASE"/nftables/proxy_whitelist6.txt) ;;
        *) fail "File is not managed by the editor" ;;
    esac
    relative="${path#"$BASE"/}"
    case "$relative" in *..*|*[!a-zA-Z0-9/_.-]*|/*|*//* ) fail "Invalid file name" ;; esac
    # Only the expected one-level named profile or subscription is allowed.
    case "$relative" in
        overrides/*)
            case "${relative#overrides/}" in
                general.yaml|dns.yaml|dns2.yaml|proxy-groups.yaml|proxy-providers.yaml|rule-providers.yaml|rules.yaml|listeners.yaml|inbound-providers.yaml|tun.yaml|sniffer.yaml|hosts.yaml|geodata.yaml|custom.yaml) ;;
                *) fail "Unknown override module" ;;
            esac ;;
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
    [ -f "$file" ] && [ ! -L "$file" ] || fail "Candidate is missing or unsafe"
    bytes="$(wc -c < "$file")"
    [ "$bytes" -le "$MAX_SIZE" ] || fail "Configuration is larger than 2 MiB"
    case "$path" in
        *.yaml|*.yml)
            if [ "${path#"$BASE"/overrides/}" != "$path" ]; then
                [ "$bytes" -le 262144 ] || fail "Override module exceeds 256 KiB"
            fi
            yq -M -e 'tag == "!!map"' "$file" >/dev/null 2>&1 || fail "Invalid YAML: top-level mapping required"
            ;;
    esac
}
save() {
    candidate="$1"
    check "$candidate"
    parent="$(dirname "$path")"
    [ -d "$parent" ] && [ ! -L "$parent" ] || fail "Target directory missing or unsafe"
    [ ! -L "$path" ] || fail "Refusing to replace a symlink"
    dir="$(backup_dir "$path")"
    mkdir -p "$dir" "$BACKUPS/.locks"
    # A per-target lock serializes normal saves, revision-checked saves and
    # restores. The expected SHA256 is checked *after* taking the lock.
    lockdir="$BACKUPS/.locks/$(basename "$dir")"
    mkdir "$lockdir" 2>/dev/null || fail "Another configuration edit is in progress"
    pending=''
    trap 'if [ -n "$pending" ]; then rm -f "$pending"; fi; rmdir "$lockdir" 2>/dev/null || :' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    if [ -n "${expected_revision:-}" ]; then
        [ -f "$path" ] && [ ! -L "$path" ] || fail "Target is missing or unsafe"
        [ "$(sha256sum "$path" | cut -d ' ' -f 1)" = "$expected_revision" ] ||
            fail "The configuration changed since it was opened; reload before saving"
    fi
    if [ -f "$path" ]; then
        archived="$(mktemp "$dir/$(date +%Y%m%dT%H%M%S).XXXXXX")"
        cp -p "$path" "$archived" || { rm -f "$archived"; fail "Backup failed"; }
    fi
    pending="$(mktemp "$parent/.nikki-rs-edit.XXXXXX")"
    cp "$candidate" "$pending"
    chmod 600 "$pending"
    mv -f "$pending" "$path"
    pending=''
    ls -1t "$dir" | sed -n '11,$p' | while IFS= read -r old; do rm -f "$dir/$old"; done
    rmdir "$lockdir" || fail "Unable to release edit lock"
    trap - EXIT INT TERM
}
command="${1:-}"
path="${2:-}"
valid_path "$path"
case "$command" in
    revision)
        [ "$#" -eq 2 ] || fail "Usage: revision PATH"
        [ -f "$path" ] && [ ! -L "$path" ] || fail "File missing or unsafe"
        sha256sum "$path" | cut -d ' ' -f 1
        ;;
    save-revision)
        [ "$#" -eq 4 ] || fail "Usage: save-revision PATH CANDIDATE EXPECTED_SHA256"
        expected_revision="$4"
        case "$expected_revision" in
            *[!0-9a-f]*|'') fail "Invalid expected revision" ;;
        esac
        [ "${#expected_revision}" -eq 64 ] || fail "Invalid revision size"
        save "$3"
        echo "Saved"
        ;;
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
