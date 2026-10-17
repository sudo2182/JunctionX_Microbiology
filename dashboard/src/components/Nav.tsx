"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/alerts", label: "Alerts" },
  { href: "/explore", label: "Explore" },
  { href: "/quality", label: "Data quality" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="flex gap-1 text-sm">
      {LINKS.map((l) => {
        const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={`rounded-md px-3 py-1.5 ${active ? "bg-ink text-white" : "text-ink-2 hover:bg-black/5"}`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
