#!/bin/bash
set -e

log_call() {
  local arg line='' separator=''
  for arg in "$@"; do
    arg=${arg//\\/\\\\}
    arg=${arg//\"/\\\"}
    arg=${arg//$'\n'/\\n}
    arg=${arg//$'\r'/\\r}
    arg=${arg//$'\t'/\\t}
    line+="${separator}\"${arg}\""
    separator=,
  done
  printf '[%s]\n' "$line" >> "$SPIDER_TEST_HC_CALLS"
}

argv=("$@")
if [[ $# == 3 && $1 == server && $2 == status && $3 == --json ]]; then
  log_call "${argv[@]}"
  [[ ${SPIDER_TEST_HC_OFFLINE:-} != 1 ]] || exit 1
  printf '%s\n' '{"core":{"id":"local-core"},"version":"0.1.16"}'
  exit 0
fi
if [[ $# == 3 && $1 == machine && $2 == ls && $3 == --json ]]; then
  log_call "${argv[@]}"
  [[ ${SPIDER_TEST_HC_OFFLINE:-} != 1 ]] || exit 1
  printf '{"machines":[{"name":"%s","id":"remote-core","state":"connected"}]}\n' "$SPIDER_TEST_HC_ALIAS"
  exit 0
fi

if [[ ${1:-} == exec ]]; then
  on_peer=false
  cmd=()
  for ((i=1; i<${#argv[@]}; i++)); do
    [[ ${argv[i]} == "--on=$SPIDER_TEST_HC_ALIAS" ]] && on_peer=true
    if [[ ${argv[i]} == -- ]]; then
      cmd=("${argv[@]:i+1}")
      break
    fi
  done
  if [[ $on_peer == true && ${#cmd[@]} -gt 0 ]]; then
    invocation=("${cmd[@]}")
    if [[ ${cmd[0]} == /usr/bin/env && ${cmd[1]:-} == "SPIDER_ROAM_PI=$SPIDER_TEST_HC_NODE" ]]; then
      cmd=("${cmd[@]:2}")
    fi
    if [[ ${cmd[0]} == cat && ${cmd[${#cmd[@]}-1]} == "$SPIDER_TEST_HC_MACHINE_FILE" ]]; then
      log_call "${argv[@]}"
      [[ ${SPIDER_TEST_HC_OFFLINE:-} != 1 ]] || exit 1
      exec /bin/cat "$SPIDER_TEST_HC_MACHINE_FILE"
    fi
    if [[ ${cmd[0]} == "$SPIDER_TEST_HC_NODE" && ${cmd[1]:-} == "$SPIDER_TEST_HC_CLI" && ${cmd[2]:-} == --global-root && ${cmd[3]:-} == "$SPIDER_TEST_HC_BOX" ]]; then
      for arg in "${cmd[@]}"; do
        if [[ $arg == start-broker ]]; then
          exec "$SPIDER_TEST_HC_NODE" "$SPIDER_TEST_HC_PROXY" "${argv[@]}"
        fi
      done
      log_call "${argv[@]}"
      [[ ${SPIDER_TEST_HC_OFFLINE:-} != 1 ]] || exit 1
      export HOME="$SPIDER_TEST_HC_BOX" PI_CODING_AGENT_DIR="$SPIDER_TEST_HC_AGENT" SPIDER_GLOBAL_ROOT="$SPIDER_TEST_HC_BOX"
      exec "${invocation[@]}"
    fi
  fi
fi
exec "$SPIDER_TEST_HC_NODE" "$SPIDER_TEST_HC_PROXY" "${argv[@]}"
