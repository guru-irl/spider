import type { Component } from "@spider/ui";
import { Panel, StatusLine, type Component as UIComponent } from "@spider/ui";
import type { SessionGroup, SessionSummary, Todo } from "./types";

const GLYPH = "🕸";

function todoLine(t: Todo): string {
  return `${t.done ? "[x]" : "[ ]"} #${t.seq} ${t.text}`;
}

export function renderTodos(todos: Todo[]): Component {
  const body = todos.length ? todos.map(todoLine) : ["(no todos)"];
  return Panel({ title: `${GLYPH} todos (${todos.length})`, body });
}

export function renderSessions(summaries: SessionSummary[]): Component {
  const body = summaries.length
    ? summaries.map(
        (s) =>
          `${s.current ? "*" : " "} ${s.name ?? s.session} — ${s.done}/${s.total} done`
      )
    : ["(no sessions)"];
  return Panel({ title: `${GLYPH} sessions (${summaries.length})`, body });
}

export function renderView(groups: SessionGroup[]): Component {
  const body: string[] = [];
  if (!groups.length) {
    body.push("(no sessions)");
  } else {
    for (const g of groups) {
      body.push(`${g.current ? "*" : " "} ${g.name ?? g.session}`);
      if (g.todos.length) {
        for (const t of g.todos) body.push(`    ${todoLine(t)}`);
      } else {
        body.push("    (no todos)");
      }
    }
  }
  return Panel({ title: `${GLYPH} view (${groups.length})`, body });
}

// Small helper reused by the command viewer to compose a status footer.
export function renderStatus(left: string, right: string): UIComponent {
  return StatusLine({ left, right });
}
