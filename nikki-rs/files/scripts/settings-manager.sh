#!/bin/sh
# Schema-constrained, revision-checked editor for commonly used clash-rs options.
# The installed JSON schema is the allowlist. Never evaluate user-supplied yq code.
set -eu

HOME_DIR="${NIKKI_HOME_DIR:-/etc/nikki-rs}"
SCHEMA="${NIKKI_SETTINGS_SCHEMA:-$HOME_DIR/schema/settings.json}"
MANAGER="${NIKKI_CONFIG_MANAGER:-$HOME_DIR/scripts/config-manager.sh}"
action="${1:-}"
module="${2:-}"
fail() { printf 'settings-manager: %s\n' "$*" >&2; exit 1; }
case "$module" in general|dns|tun|sniffer|custom) ;; *) fail 'Unknown module' ;; esac
[ -f "$SCHEMA" ] && [ ! -L "$SCHEMA" ] || fail 'Settings schema missing or unsafe'
file="$HOME_DIR/overrides/$module.yaml"
[ -f "$file" ] && [ ! -L "$file" ] || fail 'Override file missing or unsafe'
yq -e 'tag == "!!map"' "$file" >/dev/null 2>&1 || fail 'Override YAML must be a mapping'
revision() { sha256sum "$file" | cut -d ' ' -f 1; }
field_ids() {
    MODULE="$module" yq -p=json -r '.[strenv(MODULE)][] | .id' "$SCHEMA"
}
read_value() {
    ROOT="${1%%.*}"
    case "$1" in
        *.*) CHILD="${1#*.}" ROOT="$ROOT" yq -o=json -I=0 '.[strenv(ROOT)][strenv(CHILD)]' "$file" ;;
        *) ROOT="$1" yq -o=json -I=0 '.[strenv(ROOT)]' "$file" ;;
    esac
}
valid_field() {
    FIELD="$1" MODULE="$module" yq -p=json -e '
        .[strenv(MODULE)] | any_c(.id == strenv(FIELD))
    ' "$SCHEMA" >/dev/null 2>&1
}
field_kind() {
    FIELD="$1" MODULE="$module" yq -p=json -r '
        .[strenv(MODULE)][] | select(.id == strenv(FIELD)) | .kind
    ' "$SCHEMA"
}
validate_value() {
    key="$1"
    kind="$2"
    candidate="$3"
    # Explicit null removes the override to inherit the subscription or UCI.
    [ "$(yq -p=json -r 'tag' "$candidate")" != '!!null' ] || return 0
    case "$kind" in
        bool)
            yq -p=json -e 'tag == "!!bool"' "$candidate" >/dev/null 2>&1 ;;
        port)
            yq -p=json -e 'tag == "!!int" and . >= 0 and . <= 65535' "$candidate" >/dev/null 2>&1 ;;
        int)
            min="$(FIELD="$key" MODULE="$module" yq -p=json -r '
                .[strenv(MODULE)][] | select(.id == strenv(FIELD)) | .min // 0
            ' "$SCHEMA")"
            max="$(FIELD="$key" MODULE="$module" yq -p=json -r '
                .[strenv(MODULE)][] | select(.id == strenv(FIELD)) | .max // 4294967295
            ' "$SCHEMA")"
            MIN="$min" MAX="$max" yq -p=json -e '
                tag == "!!int" and . >= (env(MIN) | to_number) and . <= (env(MAX) | to_number)
            ' "$candidate" >/dev/null 2>&1 ;;
        string)
            yq -p=json -e 'tag == "!!str" and length <= 2048' "$candidate" >/dev/null 2>&1 &&
                yq -p=json -r '.' "$candidate" | awk 'END { if (NR != 1) exit 1 }' ;;
        enum)
            yq -p=json -e 'tag == "!!str"' "$candidate" >/dev/null 2>&1 || return 1
            value="$(yq -p=json -r '.' "$candidate")"
            FIELD="$key" MODULE="$module" yq -p=json -r '
                .[strenv(MODULE)][] | select(.id == strenv(FIELD)) | .choices[]
            ' "$SCHEMA" | grep -Fxq "$value" ;;
        list)
            yq -p=json -e 'tag == "!!seq" and length <= 128' "$candidate" >/dev/null 2>&1 || return 1
            if yq -p=json -r '.[] | tag' "$candidate" | grep -qv '^!!str$'; then return 1; fi
            expected="$(yq -p=json -r 'length' "$candidate")"
            yq -p=json -r '.[]' "$candidate" |
                awk -v count="$expected" 'length($0) > 512 || length($0) == 0 { bad = 1 }
                    END { if (NR != count || bad) exit 1 }' ;;
        *) return 1 ;;
    esac
}
case "$action" in
    read)
        [ "$#" -eq 2 ] || fail 'Usage: read MODULE'
        printf '{"revision":"%s","fields":' "$(revision)"
        MODULE="$module" yq -p=json -o=json -I=0 '.[strenv(MODULE)]' "$SCHEMA" | tr -d '\n'
        printf ',"values":{'
        first=1
        for key in $(field_ids); do
            [ "$first" = 1 ] || printf ','
            first=0
            FIELD="$key" yq -n -o=json -I=0 'strenv(FIELD)' | tr -d '\n'
            printf ':'
            read_value "$key" | tr -d '\n'
        done
        printf '}}\n'
        ;;
    patch)
        [ "$#" -eq 4 ] || fail 'Usage: patch MODULE JSON EXPECTED_REVISION'
        input="$3"
        expected="$4"
        case "$input" in /tmp/nikki-rs-edit.*|/var/run/nikki-rs/*) ;; *) fail 'Untrusted candidate' ;; esac
        [ -f "$input" ] && [ ! -L "$input" ] || fail 'Candidate missing or unsafe'
        [ "$(wc -c < "$input")" -le 65536 ] || fail 'Candidate too large'
        case "$expected" in *[!0-9a-f]*|'') fail 'Invalid revision' ;; esac
        [ "${#expected}" -eq 64 ] || fail 'Invalid revision length'
        yq -p=json -e 'tag == "!!map"' "$input" >/dev/null 2>&1 || fail 'Expected JSON object'
        work="$(mktemp -d /tmp/nikki-rs-settings.XXXXXX)" || fail 'Could not stage candidate'
        trap 'rm -rf "$work"' EXIT
        trap 'exit 130' INT
        trap 'exit 143' TERM
        cp "$file" "$work/result.yaml" || fail 'Unable to copy current module'
        # Parse keys as data and enforce the installed schema for *every* key.
        FIELD_COUNT=0
        for key in $(yq -p=json -r 'keys | .[]' "$input"); do
            FIELD_COUNT=$((FIELD_COUNT + 1))
            [ "$FIELD_COUNT" -le 128 ] || fail 'Too many edited fields'
            case "$key" in ''|*[!a-zA-Z0-9._-]*) fail 'Invalid field identifier' ;; esac
            valid_field "$key" || fail "Field not permitted: $key"
            kind="$(field_kind "$key")"
            FIELD="$key" yq -p=json -o=json -I=0 '.[strenv(FIELD)]' "$input" > "$work/value.json" ||
                fail "Malformed value for $key"
            validate_value "$key" "$kind" "$work/value.json" || fail "Invalid field type: $key"
            root="${key%%.*}"
            case "$key" in
                *.*)
                    child="${key#*.}"
                    if [ "$(yq -p=json -r 'tag' "$work/value.json")" = '!!null' ]; then
                        ROOT="$root" CHILD="$child" yq -i 'del(.[strenv(ROOT)][strenv(CHILD)])' "$work/result.yaml" ||
                            fail 'Unable to remove inherited field'
                    else
                        ROOT="$root" CHILD="$child" VALUE_PATH="$work/value.json" yq -i '
                            .[strenv(ROOT)][strenv(CHILD)] = load(strenv(VALUE_PATH))
                        ' "$work/result.yaml" || fail 'Unable to update field'
                    fi ;;
                *)
                    if [ "$(yq -p=json -r 'tag' "$work/value.json")" = '!!null' ]; then
                        ROOT="$root" yq -i 'del(.[strenv(ROOT)])' "$work/result.yaml" ||
                            fail 'Unable to remove inherited field'
                    else
                        ROOT="$root" VALUE_PATH="$work/value.json" yq -i '
                            .[strenv(ROOT)] = load(strenv(VALUE_PATH))
                        ' "$work/result.yaml" || fail 'Unable to update field'
                    fi ;;
            esac
        done
        [ "$FIELD_COUNT" -gt 0 ] || fail 'Nothing to save'
        sh "$MANAGER" save-revision "$file" "$work/result.yaml" "$expected" >/dev/null ||
            fail 'Revision conflict or invalid YAML'
        printf '{"success":true,"revision":"%s"}\n' "$(revision)"
        ;;
    *) fail 'Usage: read MODULE | patch MODULE JSON EXPECTED_REVISION' ;;
esac
