import type { PinPart } from '@flux/contracts';
import { useShellData } from '../app/data';
import { Icon } from '../ui';
import { pinnerLabel, usePins } from './pins';
import './pins.css';

/** The one quiet line above a pinned message's bubble (C-74, #1615): the pin glyph and "Pinned by Ada Kowalska", in `--t3` at meta size;
 * "Pinned by a former member" once the person who pinned it is deleted (the pin is the conversation's and stays). */
export function PinnedLine({ messageId, part }: { messageId: string; part?: PinPart }) {
  const pin = usePins().pinOf(messageId, part);
  const { me } = useShellData();
  if (!pin) return null;
  return <div className="pin-line" data-pinned-line=""><Icon name="pin" size={12} />Pinned by {pinnerLabel(pin, me.user.id)}</div>;
}
