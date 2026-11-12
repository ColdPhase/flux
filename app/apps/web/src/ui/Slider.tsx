import { useId, type CSSProperties } from 'react';
import './slider.css';

/**
 * A volume-like slider (#1244): a real `input type="range"`, so the arrow keys (one step), Page keys, Home and End and assistive
 * technology work as the browser gives them. Its visible label names it, the value to its right is the same value as text
 * (`aria-valuetext`), and nothing on it moves or animates.
 */
export function Slider({ label, value, onChange, min = 0, max = 200, step = 1, disabled, className, labelWidth }: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  className?: string;
  /** The label column's width when the default does not fit the label (a CSS length). */
  labelWidth?: string;
}) {
  const id = useId();
  const span = max - min;
  const fill = span > 0 ? Math.min(100, Math.max(0, ((value - min) / span) * 100)) : 0;
  const style = { '--fill': `${fill}%`, ...(labelWidth ? { '--slider-label': labelWidth } : null) } as CSSProperties;
  return (
    <div className={['ui-slider', className].filter(Boolean).join(' ')} style={style}>
      <label className="ui-slider__l" htmlFor={id}>{label}</label>
      <input id={id} className="ui-slider__r" type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        aria-valuetext={`${value}%`} onChange={(event) => onChange(event.currentTarget.valueAsNumber)} />
      <span className="ui-slider__v" aria-hidden="true">{value}%</span>
    </div>
  );
}
