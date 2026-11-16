// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan

export function automaticAgentAlert(props) {
  const title = props?.title;
  return typeof title === 'string' && props?.action?.name === 'agent.focus'
    && (title.endsWith(' finished') || title.endsWith(' needs you'));
}
