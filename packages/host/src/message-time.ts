export function formatMessageTime(date: Date): string {
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return `${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date)} ${time}`;
}
