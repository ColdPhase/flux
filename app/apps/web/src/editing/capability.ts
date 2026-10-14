import { useEffect, useState } from 'react';
import { EDITING_CAPABILITIES_PATH, type EditingCapability } from '@flux/contracts';
import { request } from '../api/client';

/**
 * The live map/wiki capability of this API (#228, #239 review), asked once per page load. Live
 * editors mount only when it is `configured`; while it is unknown or `unavailable`, maps and the
 * wiki are the ordinary ones. This module imports no editing code, so an ordinary page never
 * evaluates the shared-text/CRDT bundle.
 */
let known: EditingCapability | null = null;
let asking: Promise<EditingCapability> | null = null;

export function editingCapability(): Promise<EditingCapability> {
  if (known) return Promise.resolve(known);
  asking ??= request<{ status: EditingCapability }>(EDITING_CAPABILITIES_PATH).then((body) => {
    known = body.status === 'configured' ? 'configured' : 'unavailable';
    return known;
  }, () => {
    // Unknown is ordinary for this view; a later view asks again.
    asking = null;
    return 'unavailable' as const;
  });
  return asking;
}

export function useEditingCapability(): EditingCapability | 'loading' {
  const [capability, setCapability] = useState<EditingCapability | 'loading'>(() => known ?? 'loading');
  useEffect(() => {
    if (capability !== 'loading') return;
    let active = true;
    void editingCapability().then((value) => { if (active) setCapability(value); });
    return () => { active = false; };
  }, [capability]);
  return capability;
}
