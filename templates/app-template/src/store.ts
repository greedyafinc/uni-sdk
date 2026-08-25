// In-memory store for the template. Deliberately Vue-free: search.ts imports
// this module too, and the search chunk must never pull in the UI framework.
// A real app would back this with `sdk.storage` collections; the shape —
// listing rows that carry `title`, a short `preview`, and a write-time
// `searchText` projection — is the one the search kernel scores against.

export interface Item {
  id: string;
  title: string;
  /** Short human-visible excerpt (the search hit's snippet + text preview). */
  preview: string;
  /** Write-time content projection the search provider scores as `body`. */
  searchText: string;
  /** Epoch ms; drives the search tie-break and recency mode. */
  updatedAt: number;
}

const now = Date.now();
const seed = (
  n: number,
  title: string,
  preview: string,
  extra = "",
): Item => ({
  id: `item-${n}`,
  title,
  preview,
  searchText: `${title} ${preview} ${extra}`.trim().toLowerCase(),
  updatedAt: now - n * 60_000,
});

const items: Item[] = [
  seed(1, "Welcome note", "Getting started with My App", "onboarding intro"),
  seed(2, "Quarterly plan", "Q3 goals and key results", "okr planning roadmap"),
  seed(3, "Meeting notes", "Weekly sync with the platform team", "agenda decisions"),
  seed(4, "Grocery list", "Milk, eggs, coffee, bread", "shopping errands"),
  seed(5, "Reading list", "Papers and posts to catch up on", "articles research"),
  seed(6, "Release checklist", "Steps before shipping 1.0", "qa deploy verify"),
  seed(7, "Interview prep", "Questions for the design candidate", "hiring loop"),
  seed(8, "Travel ideas", "Kyoto in autumn, Lisbon in spring", "vacation trips"),
  seed(9, "Budget draft", "Estimated costs for the offsite", "finance spend"),
  seed(10, "Recipe box", "Weeknight pasta and slow-cooker chili", "cooking dinner"),
  seed(11, "Bug triage", "Open issues sorted by severity", "defects backlog"),
  seed(12, "Retro actions", "Follow-ups from the sprint retrospective", "team process"),
];

/** All items, newest-updated first. */
export function listItems(): Item[] {
  return [...items].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getItem(id: string): Item | undefined {
  return items.find((i) => i.id === id);
}

// ── Selection (which item the UI shows) ─────────────────────────────────────
// Plain module state + listeners so App.vue and the host actions share it
// without the store depending on Vue reactivity.

let selectedId: string | null = null;
const listeners = new Set<(id: string | null) => void>();

export function getSelectedId(): string | null {
  return selectedId;
}

/** Select an item; the UI follows via `onSelect`. Ignores unknown ids. */
export function openItem(id: string): void {
  if (!getItem(id)) return;
  selectedId = id;
  for (const cb of listeners) cb(selectedId);
}

/** Subscribe to selection changes. Returns an unsubscribe function. */
export function onSelect(cb: (id: string | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
