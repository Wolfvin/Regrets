#!/usr/bin/env bash
# String utility functions — independent fixture for Bash stack verification
# Different from PR's slugify/greet to avoid confirmation bias

trim() {
    local s="$1"
    s="${s#"${s%%[![:space:]]*}"}"
    s="${s%"${s##*[![:space:]]}"}"
    echo "$s"
}

to_camel() {
    local s="$1"
    local r="" cap=false
    for (( i=0; i<${#s}; i++ )); do
        local c="${s:$i:1}"
        if [[ "$c" == "_" ]]; then
            cap=true
        elif $cap; then
            r+=$(echo "$c" | tr '[:lower:]' '[:upper:]')
            cap=false
        else
            r+="$c"
        fi
    done
    echo "$r"
}

repeat_str() {
    local s="$1"; local n="$2"; local r=""
    for (( i=0; i<n; i++ )); do r+="$s"; done
    echo "$r"
}

is_numeric() {
    local s="$1"
    [[ "$s" =~ ^-?[0-9]+(\.[0-9]+)?$ ]] && echo "true" || echo "false"
}
