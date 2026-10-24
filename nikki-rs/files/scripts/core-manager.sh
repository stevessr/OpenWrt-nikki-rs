#!/bin/sh
# Manage an unpackaged clash-rs override without modifying /usr/bin/clash-rs.
set -eu

CORE_DIR="${NIKKI_CORE_DIR:-/etc/nikki-rs/core}"
RUN_DIR="${NIKKI_RUN_DIR:-/etc/nikki-rs/run}"
SERVICE="${NIKKI_SERVICE:-/etc/init.d/nikki-rs}"
PACKAGED="${NIKKI_PACKAGED_CORE:-/usr/bin/clash-rs}"
ACTIVE="$CORE_DIR/clash-rs"
PREVIOUS="$CORE_DIR/clash-rs.previous"
CURRENT_META="$CORE_DIR/current"
PREVIOUS_META="$CORE_DIR/previous"
LOG="$CORE_DIR/update.log"
STAGE=''
LOCK="$CORE_DIR/.update.lock"

message() { printf '%s\n' "$*" >&2; }
fail() { message "ERROR: $*"; exit 1; }
cleanup() {
    [ -z "$STAGE" ] || rm -rf "$STAGE"
    [ ! -d "$LOCK" ] || rmdir "$LOCK" 2>/dev/null || :
}
lock_core() {
    mkdir -p "$CORE_DIR"
    mkdir "$LOCK" 2>/dev/null || fail "Another core operation is running (remove stale $LOCK if necessary)"
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
}
is_running() {
    [ -x "$SERVICE" ] && "$SERVICE" status >/dev/null 2>&1
}
restart_running() {
    [ "$WAS_RUNNING" = 1 ] || return 0
    "$SERVICE" restart >/dev/null 2>&1 || return 1
    i=0
    while [ "$i" -lt 6 ]; do
        if is_running; then return 0; fi
        sleep 1
        i=$((i + 1))
    done
    return 1
}
arch_target() {
    case "$(uname -m)" in
        aarch64|arm64) echo aarch64-unknown-linux-musl ;;
        x86_64|amd64) echo x86_64-unknown-linux-musl ;;
        armv7*|armv8l|armhf) echo armv7-unknown-linux-musleabihf ;;
        riscv64) echo riscv64gc-unknown-linux-musl ;;
        i?86) echo i686-unknown-linux-musl ;;
        *) fail "Unsupported CPU architecture: $(uname -m)" ;;
    esac
}
get_variant() {
    value="${1:-$(uci -q get nikki-rs.core_update.variant 2>/dev/null || echo minimal)}"
    case "$value" in minimal|standard) printf '%s\n' "$value" ;; *) fail "Invalid core variant" ;; esac
}
status() {
    binary="$PACKAGED"
    origin=package
    [ ! -x "$ACTIVE" ] || { binary="$ACTIVE"; origin=override; }
    printf 'origin=%s\npath=%s\n' "$origin" "$binary"
    if [ -x "$binary" ]; then "$binary" -v 2>&1 | head -n 1; fi
    [ ! -f "$CURRENT_META" ] || cat "$CURRENT_META"
}
restore_previous() {
    if [ -f "$PREVIOUS" ]; then
        mv -f "$PREVIOUS" "$ACTIVE"
    else
        rm -f "$ACTIVE"
    fi
    if [ -f "$PREVIOUS_META" ]; then
        mv -f "$PREVIOUS_META" "$CURRENT_META"
    else
        rm -f "$CURRENT_META"
    fi
}
do_update() {
    variant="$(get_variant "${1:-}")"
    tag="${2:-latest}"
    case "$tag" in latest|v[0-9A-Za-z._-]*) ;; *) fail "Invalid release tag" ;; esac
    triple="$(arch_target)"
    case "$variant:$triple" in
        standard:riscv64*|standard:i686*) fail "Upstream has no standard asset for $triple" ;;
    esac

    lock_core
    STAGE="$(mktemp -d "$CORE_DIR/.stage.XXXXXX")" || fail "Cannot allocate staging directory"
    if [ "$tag" = latest ]; then
        curl --proto '=https' --proto-redir '=https' -fLsS --retry 2 --connect-timeout 10 --max-time 40 \
            https://api.github.com/repos/CHKayanami/clash-rs/releases/latest -o "$STAGE/release.json" \
            || fail "Could not fetch release metadata"
        tag="$(jsonfilter -i "$STAGE/release.json" -e '@.tag_name')"
        case "$tag" in v[0-9A-Za-z._-]*) ;; *) fail "Release API returned invalid tag" ;; esac
    fi
    asset="clash-rs-$variant-$triple.tar.gz"
    url="https://github.com/CHKayanami/clash-rs/releases/download/$tag/$asset"
    message "Downloading $asset ($tag)"
    curl --proto '=https' --proto-redir '=https' -fLsS --retry 2 --connect-timeout 15 --max-time 240 \
        "$url" -o "$STAGE/core.tar.gz" || fail "Core download failed"

    # Verify a digest supplied by GitHub's release API when one is available.
    if [ -f "$STAGE/release.json" ] && [ -f /usr/share/libubox/jshn.sh ]; then
        . /usr/share/libubox/jshn.sh
        json_load "$(cat "$STAGE/release.json")"
        json_select assets
        json_get_keys indexes
        digest=''
        for index in $indexes; do
            json_select "$index"
            json_get_var name name
            if [ "$name" = "$asset" ]; then
                json_get_var digest digest
                json_select ..
                break
            fi
            json_select ..
        done
        case "$digest" in
            sha256:*)
                expected="${digest#sha256:}"
                actual="$(sha256sum "$STAGE/core.tar.gz" | cut -d ' ' -f 1)"
                [ "$actual" = "$expected" ] || fail "SHA256 digest mismatch"
                ;;
            '') message "Release API has no SHA256 digest for this asset; relying on HTTPS" ;;
            *) fail "Unexpected digest format from release API" ;;
        esac
    fi

    member="$(tar -tzf "$STAGE/core.tar.gz" | grep -E '(^|/)clash-rs$' | head -n 1)"
    [ -n "$member" ] || fail "Archive does not contain clash-rs"
    tar -xOzf "$STAGE/core.tar.gz" "$member" > "$STAGE/clash-rs" || fail "Extraction failed"
    chmod 755 "$STAGE/clash-rs"
    "$STAGE/clash-rs" -v >/dev/null 2>&1 || fail "Downloaded core is not executable on this router"
    if [ -f "$RUN_DIR/config.yaml" ]; then
        "$STAGE/clash-rs" -d "$RUN_DIR" -t > "$STAGE/test.log" 2>&1 || {
            cat "$STAGE/test.log" >&2
            fail "Downloaded core rejected the current generated configuration"
        }
    fi

    WAS_RUNNING=0
    if is_running; then WAS_RUNNING=1; fi
    rm -f "$PREVIOUS" "$PREVIOUS_META"
    if [ -f "$ACTIVE" ]; then
        cp -p "$ACTIVE" "$PREVIOUS" || fail "Cannot back up previous override"
    fi
    if [ -f "$CURRENT_META" ]; then
        cp -p "$CURRENT_META" "$PREVIOUS_META" || fail "Cannot back up previous metadata"
    fi
    # Atomic rename on the same filesystem. The package-managed binary stays untouched.
    mv -f "$STAGE/clash-rs" "$ACTIVE" || { restore_previous; fail "Could not install new core"; }
    printf 'variant=%s\ntag=%s\n' "$variant" "$tag" > "$CURRENT_META"
    if ! restart_running; then
        message "New core failed to start: restoring previous core"
        restore_previous
        restart_running || message "WARNING: automatic service recovery failed; check logs"
        fail "Core update rolled back"
    fi
    message "Core updated to $tag ($variant)"
}
do_rollback() {
    lock_core
    [ -f "$ACTIVE" ] || fail "No override installed"
    WAS_RUNNING=0
    if is_running; then WAS_RUNNING=1; fi
    STAGE="$(mktemp -d "$CORE_DIR/.stage.XXXXXX")" || fail "Cannot allocate staging directory"
    cp -p "$ACTIVE" "$STAGE/current"
    [ ! -f "$CURRENT_META" ] || cp -p "$CURRENT_META" "$STAGE/current.meta"
    restore_previous
    if ! restart_running; then
        mv -f "$STAGE/current" "$ACTIVE"
        [ ! -f "$STAGE/current.meta" ] || mv -f "$STAGE/current.meta" "$CURRENT_META"
        restart_running || message "WARNING: service could not be recovered"
        fail "Rollback failed: restored newer core"
    fi
    message "Rolled back to previous core (or packaged binary)"
}

case "${1:-}" in
    status) status ;;
    update) do_update "${2:-}" "${3:-}" 2>&1 | tee -a "$LOG" ;;
    rollback) do_rollback 2>&1 | tee -a "$LOG" ;;
    *) message "Usage: $0 {status|update [minimal|standard] [latest|vTAG]|rollback}"; exit 2 ;;
esac
