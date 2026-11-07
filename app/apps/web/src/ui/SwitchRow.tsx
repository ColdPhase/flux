import { useId, type ReactNode } from 'react';

/** An on/off switch with its label and an optional line under it, the whole row a target. */
export function SwitchRow({ label, detail, checked, onChange, icon, disabled }: {
  label: string; detail?: ReactNode; checked: boolean; onChange: (on: boolean) => void; icon?: ReactNode; disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="sset-row">
      {icon ? <span className="sset-row__ic" aria-hidden="true">{icon}</span> : null}
      <label className="sset-row__b" htmlFor={id}>
        <span className="sset-row__t">{label}</span>
        {detail ? <span className="sset-row__s" id={`${id}-d`}>{detail}</span> : null}
      </label>
      <button type="button" role="switch" id={id} className="sset-switch" aria-checked={checked} disabled={disabled}
        aria-describedby={detail ? `${id}-d` : undefined} onClick={() => onChange(!checked)}>
        <span aria-hidden="true" />
      </button>
    </div>
  );
}
