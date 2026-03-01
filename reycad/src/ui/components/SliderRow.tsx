type SliderRowProps = {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
};

export function SliderRow({ label, min, max, step = 1, value, onChange }: SliderRowProps): JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      <input className="input" max={max} min={min} step={step} type="range" value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <span className="mono">{value}</span>
    </label>
  );
}
