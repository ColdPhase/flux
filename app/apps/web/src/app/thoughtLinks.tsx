import { useEffect, useState } from 'react';
import { getSketch } from '../api/sketches';
import { RefLink } from '../place/origin';
import { Icon } from '../ui';

// A map thought's own address in a message (#1376: Copy link replaces Cite). A thought's Copy link, `/map/:id#thought-:id` on My map or
// `/projects/:p/map/:id#thought-:id` on a space's map, pasted into a message reads as a chip with the thought's first line that opens the
// map with the thought selected. The title is read with the reader's own access (the map's read), so a reader who may not read that map
// sees "Thought not available" and nothing of it. The stored body keeps the address as it was written.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PATH = new RegExp(`^(?:/projects/${UUID})?/map/(${UUID})$`, 'i');
const HASH = new RegExp(`^#thought-(${UUID})$`, 'i');
const ONE_LINE = 120;

export interface ThoughtLink { sketchId: string; thoughtId: string; to: string }

/** The thought an address of this Flux names, or null for any other address (another site's, another page of Flux). */
export function thoughtLink(raw: string): ThoughtLink | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (typeof window === 'undefined' || url.origin !== window.location.origin || url.search) return null;
  const path = PATH.exec(url.pathname);
  const hash = HASH.exec(url.hash);
  return path && hash ? { sketchId: path[1]!.toLowerCase(), thoughtId: hash[1]!.toLowerCase(), to: `${url.pathname}${url.hash}` } : null;
}

/** Each map is read once per visit for every chip that names it; a map the reader may not read is null. */
const maps = new Map<string, Promise<Map<string, string> | null>>();
function titles(sketchId: string): Promise<Map<string, string> | null> {
  let read = maps.get(sketchId);
  if (!read) {
    read = getSketch(sketchId).then((sketch) => new Map(sketch.thoughts.map((thought) => {
      const first = thought.text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
      return [thought.id, (first.length > ONE_LINE ? `${first.slice(0, ONE_LINE - 1).trimEnd()}…` : first) || 'Thought'];
    })), () => null);
    maps.set(sketchId, read);
  }
  return read;
}

/** The chip of one thought's address, on the text's baseline like `#4` and `[[Page]]`. */
export function ThoughtChip({ link, linked = true }: { link: ThoughtLink; linked?: boolean }) {
  const [title, setTitle] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void titles(link.sketchId).then((found) => { if (live) setTitle(found?.get(link.thoughtId) ?? null); });
    return () => { live = false; };
  }, [link.sketchId, link.thoughtId]);
  if (title === null) {
    return <span className="ref-chip ref-chip--thought is-unavailable" data-ref="thought" data-ref-state="unavailable"><Icon name="lock" size={12} />Thought not available</span>;
  }
  const text = title ?? 'Thought';
  const inner = <><Icon name="map" size={12} /><span className="ui-vh">Thought on a map: </span>{text}</>;
  return linked
    ? <RefLink className="ref-chip ref-chip--thought" data-ref="thought" data-ref-state={title ? 'available' : 'loading'} to={link.to}>{inner}</RefLink>
    : <span className="ref-chip ref-chip--thought" data-ref="thought" data-ref-state={title ? 'available' : 'loading'}>{inner}</span>;
}
