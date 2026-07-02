export interface Todo {
  seq: number;
  text: string;
  done: boolean;
}

export interface SessionSummary {
  session: string;
  name?: string;
  total: number;
  done: number;
  current: boolean;
}

export interface SessionGroup {
  session: string;
  name?: string;
  current: boolean;
  todos: Todo[];
}
