export interface SnippetVariableState {
  [key: string]: string;
}

export interface SnippetRecord {
  id: string;
  label: string;
  command: string;
  autoEnter: boolean;
  group?: string;
  pinned?: boolean;
  sortOrder?: number;
  icon?: string;
  lastUsedVars?: SnippetVariableState;
}

export interface SnippetGroup {
  name: string;
  snippets: SnippetRecord[];
}

const TEMPLATE_PATTERN = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;

const toNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

export const getSnippetStorageKey = (): string => "remux-snippets";

export const normalizeSnippets = (value: unknown): SnippetRecord[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const id = toNonEmptyString(record.id) ?? `snippet-${index}`;
    const label = toNonEmptyString(record.label);
    const command = toNonEmptyString(record.command);
    if (!label || !command) {
      return [];
    }

    const lastUsedVars = record.lastUsedVars && typeof record.lastUsedVars === "object"
      ? Object.fromEntries(
          Object.entries(record.lastUsedVars as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        )
      : undefined;

    return [{
      id,
      label,
      command,
      autoEnter: record.autoEnter !== false,
      group: toNonEmptyString(record.group),
      pinned: record.pinned === true,
      sortOrder: typeof record.sortOrder === "number" ? record.sortOrder : index,
      icon: typeof record.icon === "string" ? record.icon : undefined,
      lastUsedVars
    }];
  });
};

export const sortSnippets = (snippets: SnippetRecord[]): SnippetRecord[] => {
  return [...snippets].sort((left, right) => {
    const orderDelta = (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
    if (orderDelta !== 0) {
      return orderDelta;
    }
    return left.label.localeCompare(right.label);
  });
};

export const assignSnippetSortOrders = (snippets: SnippetRecord[]): SnippetRecord[] => {
  return snippets.map((snippet, index) => ({
    ...snippet,
    sortOrder: index
  }));
};

export const groupSnippets = (snippets: SnippetRecord[]): SnippetGroup[] => {
  const groups = new Map<string, SnippetRecord[]>();
  for (const snippet of sortSnippets(snippets)) {
    const name = snippet.group?.trim() || "Ungrouped";
    const bucket = groups.get(name);
    if (bucket) {
      bucket.push(snippet);
    } else {
      groups.set(name, [snippet]);
    }
  }

  return Array.from(groups.entries())
    .sort(([left], [right]) => {
      if (left === "Ungrouped") {
        return 1;
      }
      if (right === "Ungrouped") {
        return -1;
      }
      return left.localeCompare(right);
    })
    .map(([name, grouped]) => ({ name, snippets: grouped }));
};

export const getPinnedSnippets = (snippets: SnippetRecord[]): SnippetRecord[] => {
  return sortSnippets(snippets.filter((snippet) => snippet.pinned));
};

export const extractSnippetVariables = (command: string): string[] => {
  const matches = new Set<string>();
  for (const match of command.matchAll(TEMPLATE_PATTERN)) {
    if (match[1]) {
      matches.add(match[1]);
    }
  }
  return Array.from(matches);
};

export const fillSnippetTemplate = (
  command: string,
  values: Record<string, string>
): string => {
  return command.replace(TEMPLATE_PATTERN, (_full, key: string) => values[key] ?? "");
};

export const snippetSearchText = (snippet: SnippetRecord): string => {
  return [
    snippet.label,
    snippet.command,
    snippet.group,
    snippet.icon
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
};

export const filterSnippets = (snippets: SnippetRecord[], rawQuery: string): SnippetRecord[] => {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return sortSnippets(snippets);
  }
  return sortSnippets(
    snippets.filter((snippet) => snippetSearchText(snippet).includes(query))
  );
};

export const reorderById = <T extends { id: string }>(
  items: T[],
  draggedId: string,
  targetId: string
): T[] => {
  if (draggedId === targetId) {
    return items;
  }
  const next = [...items];
  const draggedIndex = next.findIndex((item) => item.id === draggedId);
  const targetIndex = next.findIndex((item) => item.id === targetId);
  if (draggedIndex === -1 || targetIndex === -1) {
    return items;
  }
  const [dragged] = next.splice(draggedIndex, 1);
  next.splice(targetIndex, 0, dragged);
  return next;
};
