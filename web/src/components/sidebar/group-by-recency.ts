import type { ChatSessionSummary } from "@/components/app-data-context";

const DAY_MS = 24 * 60 * 60 * 1000;

export function groupByRecency(sessions: ChatSessionSummary[]): [string, ChatSessionSummary[]][] {
  const startOfToday = new Date().setHours(0, 0, 0, 0);

  const groups = new Map<string, ChatSessionSummary[]>();
  const order = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];
  for (const label of order) groups.set(label, []);

  for (const session of sessions) {
    const updated = new Date(session.updatedAt).getTime();
    const daysAgo = Math.floor((startOfToday - updated) / DAY_MS);

    let label: string;
    if (updated >= startOfToday) label = "Today";
    else if (daysAgo <= 1) label = "Yesterday";
    else if (daysAgo <= 7) label = "Previous 7 days";
    else if (daysAgo <= 30) label = "Previous 30 days";
    else label = "Older";

    groups.get(label)!.push(session);
  }

  return order
    .map((label): [string, ChatSessionSummary[]] => [label, groups.get(label)!])
    .filter(([, items]) => items.length > 0);
}
