import { useState } from 'react';
import { Sheet } from '../ui';
import { FileIcon, useObjectUrl } from './Attachments';
import { looksLikePhoto } from './fileKind';
import './attachments.css';

/**
 * On a phone, several files chosen at once (#348 AC-4) open a sheet: tap them in the order they should
 * send. Each selected one shows its send number; tapping it again takes it out and the rest renumber.
 * "Add" attaches the selection in tap order. Choosing one file, or any choice on a larger screen, skips it.
 */
export function PhotoPicker({ files, onAdd, onClose }: { files: File[]; onAdd: (chosen: File[]) => void; onClose: () => void }) {
  const [order, setOrder] = useState<number[]>([]);
  const toggle = (index: number) => setOrder((current) => current.includes(index) ? current.filter((other) => other !== index) : [...current, index]);
  return <Sheet open label="Choose files to send" onClose={onClose} className="photo-pick">
    <div className="photo-pick__head">
      <h2>Choose files to send</h2>
      <p>Tap them in the order they should send. Tap again to take one out.</p>
    </div>
    <ul className="photo-pick__grid" aria-label={`${files.length} files to choose from`}>
      {files.map((file, index) => {
        const at = order.indexOf(index);
        return <PickTile key={`${index}:${file.name}`} file={file} number={at < 0 ? 0 : at + 1} onToggle={() => toggle(index)} />;
      })}
    </ul>
    <div className="photo-pick__foot">
      <button type="button" className="photo-pick__cancel" onClick={onClose}>Cancel</button>
      <button type="button" className="photo-pick__add" disabled={!order.length} onClick={() => onAdd(order.map((index) => files[index]!))}>Add {order.length}</button>
    </div>
  </Sheet>;
}

function PickTile({ file, number, onToggle }: { file: File; number: number; onToggle: () => void }) {
  const url = useObjectUrl(looksLikePhoto(file.name) ? file : null);
  const on = number > 0;
  return <li>
    <button type="button" className={`photo-pick__tile${on ? ' is-on' : ''}`} aria-pressed={on} onClick={onToggle}
      aria-label={on ? `${file.name}, send ${number}` : file.name}>
      <span className="photo-pick__face">{url ? <img src={url} alt="" draggable={false} /> : <FileIcon name={file.name} size={34} />}</span>
      <span className="photo-pick__num" aria-hidden="true">{on ? number : ''}</span>
    </button>
  </li>;
}
