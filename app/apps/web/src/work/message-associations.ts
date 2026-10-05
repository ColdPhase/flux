import type { NativeWorkRow, SourceAssociationCounts, WorkAssociations } from '@flux/contracts';

export interface MessageWorkPreview { counts: SourceAssociationCounts; items: NativeWorkRow[] }

/** One globally bounded native object/edge observation; never a complete project graph. */
export function messageWorkPreviews(page: WorkAssociations): Map<string, MessageWorkPreview> {
  const objects = new Map(page.items.map((item) => [`${item.kind}:${item.id}`, item]));
  const previews = new Map(page.sources.map((counts) => [counts.messageId, { counts, items: [] as NativeWorkRow[] }]));
  const seen = new Set<string>();
  for (const edge of page.edges.items) {
    if (edge.role !== 'source' || edge.to.type !== 'message') continue;
    const key = `${edge.from.type}:${edge.from.id}`;
    const item = objects.get(key);
    const preview = previews.get(edge.to.id);
    const association = `${edge.to.id}:${key}`;
    if (!item || !preview || seen.has(association)) continue;
    seen.add(association); preview.items.push(item);
  }
  // Native row order is independent of relationship chronology.
  const order = new Map(page.items.map((item, index) => [`${item.kind}:${item.id}`, index]));
  for (const preview of previews.values()) preview.items.sort((a, b) => order.get(`${a.kind}:${a.id}`)! - order.get(`${b.kind}:${b.id}`)!);
  return previews;
}

/** Keep a stable <=100-message batch while it still covers the actual viewport. */
export function visibleMessageBatch(all: readonly string[], visible: readonly string[], previous: readonly string[]): string[] {
  if (all.length <= 100) return [...all];
  const valid = new Set(all);
  const retained = previous.length > 0 && previous.length <= 100 && previous.every((id) => valid.has(id));
  if (retained && visible.every((id) => previous.includes(id))) return [...previous];
  const indices = visible.map((id) => all.indexOf(id)).filter((index) => index >= 0);
  if (!indices.length) return retained ? [...previous] : all.slice(-100);
  const first = Math.min(...indices), last = Math.max(...indices);
  const start = Math.max(0, Math.min(first - 25, all.length - 100), last - 99);
  return all.slice(start, start + 100);
}
