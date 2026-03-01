type ColorPickerProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
};

export function ColorPicker({ label, value, onChange }: ColorPickerProps): JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      <input className="input" type="color" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}
