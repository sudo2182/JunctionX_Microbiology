import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileDown, FileSpreadsheet, FileText } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { defaultOptions, renderReportHtml, reportCsv, reportFileName, type ReportDoc, type ReportOptions } from "@/lib/report/report";

/**
 * "Download report" for every page. A page registers a builder (useReport) that sees its current filters; the button
 * in the page header builds the report only when opened, lets the user customise it, and downloads PDF or CSV.
 */

type Builder = () => ReportDoc;
type Ctx = { register: (b: (() => Builder) | null) => void; build: () => ReportDoc | null; available: boolean };
const ReportCtx = createContext<Ctx | null>(null);

export function ReportProvider({ children }: { children: ReactNode }) {
  const current = useRef<(() => Builder) | null>(null);
  const [available, setAvailable] = useState(false);
  const register = useCallback((b: (() => Builder) | null) => {
    current.current = b;
    setAvailable(b !== null);
  }, []);
  const value = useMemo<Ctx>(() => ({ register, available, build: () => (current.current ? current.current()() : null) }), [register, available]);
  return <ReportCtx.Provider value={value}>{children}</ReportCtx.Provider>;
}

/** Registers this page's report builder; it always uses the page's latest state when the report is generated. */
export function useReport(build: Builder | null) {
  const ctx = useContext(ReportCtx);
  const latest = useRef(build);
  latest.current = build;
  const ready = build !== null;
  useEffect(() => {
    if (!ctx || !ready) return;
    ctx.register(() => () => latest.current!());
    return () => ctx.register(null);
  }, [ctx, ready]);
}

function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Prints the report from a hidden frame; the browser's print dialog offers "Save as PDF". */
function printReport(html: string, fileTitle: string) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc || !frame.contentWindow) throw new Error("Your browser blocked the print window.");
  doc.open();
  doc.write(html);
  doc.close();
  const pageTitle = document.title;
  document.title = fileTitle; // browsers use the page title as the suggested PDF file name
  const restore = () => { document.title = pageTitle; setTimeout(() => frame.remove(), 1000); };
  frame.contentWindow.addEventListener("afterprint", restore, { once: true });
  setTimeout(() => {
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
    setTimeout(restore, 60_000); // fallback if afterprint never fires
  }, 250);
}

export function ReportButton() {
  const ctx = useContext(ReportCtx);
  const [open, setOpen] = useState(false);
  const [doc, setDoc] = useState<ReportDoc | null>(null);
  const [opts, setOpts] = useState<ReportOptions | null>(null);
  const [format, setFormat] = useState<"pdf" | "csv">("pdf");
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    setError(null);
    try {
      const d = ctx?.build() ?? null;
      if (!d) throw new Error("This page's data is still loading.");
      setDoc(d);
      setOpts((prev) => (prev && doc?.id === d.id ? { ...prev, sections: prev.sections.filter((s) => d.sections.some((x) => x.id === s)) } : defaultOptions(d)));
      setOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not build the report");
    }
  };

  const go = () => {
    if (!doc || !opts) return;
    setError(null);
    const now = new Date();
    try {
      if (opts.sections.length === 0) throw new Error("Choose at least one section.");
      if (format === "csv") {
        download(reportFileName(doc, now, "csv"), "﻿" + reportCsv(doc, opts, now), "text/csv;charset=utf-8");
        toast.success("Report data downloaded");
      } else {
        printReport(renderReportHtml(doc, opts, now), reportFileName(doc, now, "pdf").replace(/\.pdf$/, ""));
      }
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggle = (k: "keyFacts" | "tables" | "methods" | "limitations") => setOpts((o) => (o ? { ...o, [k]: !o[k] } : o));

  return (
    <>
      <Button variant="outline" size="sm" className="gap-2" onClick={start} disabled={!ctx?.available} title={ctx?.available ? "Download a report of this page" : "Report available once the data has loaded"}>
        <FileDown className="h-4 w-4" />
        Download report
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Download report</DialogTitle>
            <DialogDescription>Built from this page with its current filters{doc ? ` · ${doc.period}` : ""}.</DialogDescription>
          </DialogHeader>
          {doc && opts && (
            <div className="flex flex-col gap-4 text-sm">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2"><Label htmlFor="rep-title" className="text-xs">Report title</Label><Input id="rep-title" value={opts.title} maxLength={140} onChange={(e) => setOpts({ ...opts, title: e.target.value })} /></div>
                <div className="sm:col-span-2"><Label htmlFor="rep-by" className="text-xs">Prepared by (optional)</Label><Input id="rep-by" value={opts.preparedBy} maxLength={120} placeholder="e.g. Infection control team, Tyks" onChange={(e) => setOpts({ ...opts, preparedBy: e.target.value })} /></div>
              </div>
              <fieldset>
                <legend className="mb-1.5 text-xs font-medium">Sections</legend>
                <div className="grid gap-1.5">
                  {doc.sections.map((s) => (
                    <label key={s.id} className="flex items-center gap-2">
                      <Checkbox checked={opts.sections.includes(s.id)} onCheckedChange={(v) => setOpts({ ...opts, sections: v ? [...opts.sections, s.id] : opts.sections.filter((x) => x !== s.id) })} />
                      {s.heading}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend className="mb-1.5 text-xs font-medium">Include</legend>
                <div className="grid grid-cols-2 gap-1.5">
                  {([["keyFacts", "Key facts"], ["tables", "Data tables"], ["methods", "Methods & definitions"], ["limitations", "Limitations"]] as const).map(([k, label]) => (
                    <label key={k} className="flex items-center gap-2"><Checkbox checked={opts[k]} onCheckedChange={() => toggle(k)} />{label}</label>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend className="mb-1.5 text-xs font-medium">Format</legend>
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Format">
                  {([["pdf", FileText, "PDF report", "A4, print quality (choose “Save as PDF”)"], ["csv", FileSpreadsheet, "CSV data", "All tables, for Excel"]] as const).map(([k, Icon, label, hint]) => (
                    <button key={k} type="button" role="radio" aria-checked={format === k} onClick={() => setFormat(k)} className={`rounded-md border p-2.5 text-left ${format === k ? "border-primary bg-primary/10 ring-1 ring-primary" : "hover:border-primary/60"}`}>
                      <span className="flex items-center gap-2 font-medium"><Icon className="h-4 w-4 text-primary" />{label}</span>
                      <span className="text-xs text-muted-foreground">{hint}</span>
                    </button>
                  ))}
                </div>
              </fieldset>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={go} className="gap-2"><FileDown className="h-4 w-4" />{format === "pdf" ? "Create PDF" : "Download CSV"}</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
