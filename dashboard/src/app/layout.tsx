import type { Metadata } from "next";
import Link from "next/link";

import { Nav } from "@/components/Nav";
import { ReplayBanner } from "@/components/ReplayBanner";
import "./globals.css";

export const metadata: Metadata = {
  title: "AMR Watch",
  description: "Continuously updated, laboratory-based antimicrobial resistance surveillance.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/" className="text-base font-semibold tracking-tight">
              AMR Watch
            </Link>
            <Nav />
            <div className="ml-auto">
              <ReplayBanner />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-7xl px-4 pb-8 text-xs text-muted">
          Synthetic Finnish hospital data. Aggregates only: no patient identifiers or exact dates are shown. Rates use
          the first isolate per patient, organism and specimen in each window; percentages need at least 30 isolates.
        </footer>
      </body>
    </html>
  );
}
