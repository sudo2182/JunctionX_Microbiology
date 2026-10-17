import { ORGANISMS, shortOrg } from "@/lib/amr/reference";

export function OrgChips({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const toggle = (o: string) => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o]);
  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        onClick={() => onChange(value.length === ORGANISMS.length ? [] : [...ORGANISMS])}
        className="rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
      >
        {value.length === ORGANISMS.length ? "Clear" : "All"}
      </button>
      {ORGANISMS.map((o) => (
        <button
          key={o}
          onClick={() => toggle(o)}
          className={`rounded-full border px-3 py-1 text-xs italic transition-colors ${value.includes(o) ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}
        >
          {shortOrg(o)}
        </button>
      ))}
    </div>
  );
}
