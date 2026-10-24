#!/bin/sh
# Transactional Advanced Config save+apply with a bounded restart health check.
# This command is only invoked after an explicit LuCI action; ordinary saves
# stay offline. On failure restore the previous *module*, not a subscription.
set -eu

HOME_DIR="${NIKKI_HOME_DIR:-/etc/nikki-rs}"
MANAGER="${NIKKI_CONFIG_MANAGER:-$HOME_DIR/scripts/config-manager.sh}"
COMPOSER="${NIKKI_COMPOSER:-$HOME_DIR/scripts/override-manager.sh}"
SERVICE="${NIKKI_APPLY_SERVICE:-/etc/init.d/nikki-rs}"
BASE="$HOME_DIR/run/base.yaml"
WAIT="${NIKKI_APPLY_WAIT:-10}"
LOCK="$HOME_DIR/run/.config-apply.lock"
SAVED=0
COMMITTED=0
NEW_REV=''
STAGING=''

report() { printf '%s\n' "$1"; }
fail() { report "$1"; exit 1; }
hash() { sha256sum "$1" | cut -d ' ' -f 1; }
healthy() {
    "$SERVICE" status >/dev/null 2>&1 || return 1
    if [ -n "${NIKKI_APPLY_HEALTHCHECK:-}" ]; then
        "${NIKKI_APPLY_HEALTHCHECK}" >/dev/null 2>&1
    else
        pidof clash-rs >/dev/null 2>&1
    fi
}
rollback() {
    [ "$SAVED" = 1 ] || return 0
    # Never overwrite a subsequent write by another client.
    [ -f "$file" ] && [ ! -L "$file" ] && [ "$(hash "$file")" = "$NEW_REV" ] ||
        return 1
    sh "$MANAGER" save-revision "$file" "$STAGING/previous.yaml" "$NEW_REV" >/dev/null ||
        return 1
    SAVED=0
    "$SERVICE" restart >/dev/null 2>&1 || return 1
    delay=0
    while [ "$delay" -le "$WAIT" ]; do
        healthy && return 0
        [ "$delay" -lt "$WAIT" ] || break
        sleep 1
        delay=$((delay + 1))
    done
    return 1
}
cleanup() {
    result="$?"
    trap - EXIT INT TERM
    if [ "$COMMITTED" != 1 ] && [ "$SAVED" = 1 ]; then
        if rollback; then report 'ROLLED_BACK'; else report 'ROLLBACK_FAILED'; fi
    fi
    [ -z "$STAGING" ] || rm -rf "$STAGING"
    [ ! -d "$LOCK" ] || rmdir "$LOCK" 2>/dev/null || :
    exit "$result"
}

[ "$#" -eq 4 ] && [ "$1" = apply ] || fail 'INVALID_REQUEST'
module="$2"
candidate="$3"
expected="$4"
case "$module" in general|dns|dns2|proxy-groups|proxy-providers|rule-providers|rules|listeners|inbound-providers|tun|sniffer|hosts|geodata|custom) ;; *) fail 'INVALID_MODULE' ;; esac
case "$candidate" in /tmp/nikki-rs-edit.*|/var/run/nikki-rs/*) ;; *) fail 'INVALID_CANDIDATE' ;; esac
case "$expected" in *[!0-9a-f]*|'') fail 'INVALID_REVISION' ;; esac
[ "${#expected}" -eq 64 ] || fail 'INVALID_REVISION'
case "$WAIT" in *[!0-9]*|'') fail 'INVALID_WAIT' ;; esac
[ "$WAIT" -le 30 ] || fail 'INVALID_WAIT'
file="$HOME_DIR/overrides/$module.yaml"
[ -f "$file" ] && [ ! -L "$file" ] || fail 'MODULE_UNAVAILABLE'
[ -f "$candidate" ] && [ ! -L "$candidate" ] || fail 'INVALID_CANDIDATE'
[ -f "$BASE" ] && [ ! -L "$BASE" ] || fail 'BASE_UNAVAILABLE'
[ -x "$SERVICE" ] || fail 'SERVICE_UNAVAILABLE'
mkdir "$LOCK" 2>/dev/null || fail 'APPLY_BUSY'
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
STAGING="$(mktemp -d "$HOME_DIR/run/.config-apply.XXXXXX")" || fail 'STAGING_FAILED'
cp -p "$file" "$STAGING/previous.yaml" || fail 'STAGING_FAILED'
[ "$(hash "$file")" = "$expected" ] || fail 'CONFLICT'
healthy || fail 'SERVICE_NOT_RUNNING'

# Same normalized effective configuration as the LuCI preview, including
# the eBPF/TUN safety override; core test runs against a *temporary* config.
sh "$COMPOSER" test "$BASE" "$module" "$candidate" > /dev/null 2>&1 ||
    fail 'PREFLIGHT_FAILED'
[ "$(hash "$file")" = "$expected" ] || fail 'CONFLICT'

# config-manager holds the per-file lock during version comparison and rename.
sh "$MANAGER" save-revision "$file" "$candidate" "$expected" > /dev/null ||
    fail 'SAVE_FAILED'
NEW_REV="$(hash "$file")"
SAVED=1
if ! "$SERVICE" restart >/dev/null 2>&1; then
    fail 'RESTART_FAILED'
fi

# Allow the old process to stop before assessing procd and the new core.
sleep 1
delay=0
while [ "$delay" -le "$WAIT" ]; do
    if healthy; then
        SAVED=0
        COMMITTED=1
        report 'APPLIED'
        exit 0
    fi
    [ "$delay" -lt "$WAIT" ] || break
    sleep 1
    delay=$((delay + 1))
done
fail 'HEALTHCHECK_FAILED'
