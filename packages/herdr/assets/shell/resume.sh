# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Gurupungav Narayanan
# Sourced with the installed Node, CLI, and user-config paths as arguments.
case $- in
  *i*)
    if [ -x "$1" ] && [ -r "$2" ] && [ -n "${HC_TERMINAL_ID:-}" ] && [ -n "${HC_TERMINAL_SOCKET:-}" ]; then
      unset SPIDER_HERDR_LEASE_TOKEN SPIDER_HERDR_LEASE_FILE
      _spider_resume_offer="$("$1" "$2" resume-offer --config "$3")" || _spider_resume_offer=''
      if [ -n "$_spider_resume_offer" ]; then
        eval "$_spider_resume_offer"
      fi
      unset _spider_resume_offer
    fi
    ;;
esac
