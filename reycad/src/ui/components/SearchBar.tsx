type SearchBarProps = {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
};

export function SearchBar({ value, placeholder, onChange }: SearchBarProps): JSX.Element {
  return <input className="input" placeholder={placeholder ?? "Search"} value={value} onChange={(event) => onChange(event.target.value)} />;
}
