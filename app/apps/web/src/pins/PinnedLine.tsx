import type { PinPart } from '@flux/contracts';
import { youLabel } from '../docs/format';
import { useShellData } from '../app/data';
import { Icon } from '../ui';
import { usePins } from './pins';
import './pins.css';

/** The one quiet line above a pinned message's bubble (C-74, #1615): the pin glyph and "Pinned by Ada Kowalska", in `--t3` at meta size. */
export function PinnedLine({ messageId, part }: { messageId: string; part?: PinPart }) {
  const pin = usePins().pinOf(messageId, part);
  const { me } = useShellData();
  if (!pin) return null;
  return <p className="pin-line" data-pinned-line=""><Icon name="pin" size={12} />Pinned by {youLabel(pin.pinnedBy.name, pin.pinnedBy.id === me.user.id)}</p>;
}
