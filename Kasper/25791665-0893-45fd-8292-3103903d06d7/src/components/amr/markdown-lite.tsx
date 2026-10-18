import { useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * Renders the small markdown subset the assistant is told to use (paragraphs, bullets, numbered lists,
 * **bold**, `code`, [links](url)). Builds React nodes only, never raw HTML. Links: same-site paths open in the
 * app, https links open in a new tab, anything else is shown as plain text.
 */
export function MarkdownLite({ text }: { text: string }) {
  const router = useRouter();
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(" "), router)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{inline(it, router)}</li>);
    blocks.push(list.ordered ? <ol key={blocks.length} className="ml-5 list-decimal space-y-0.5">{items}</ol> : <ul key={blocks.length} className="ml-5 list-disc space-y-0.5">{items}</ul>);
    list = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      blocks.push(<p key={blocks.length} className="font-semibold">{inline(heading[1], router)}</p>);
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return <div className="space-y-2 text-sm leading-relaxed">{blocks}</div>;
}

const TOKEN = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;

function inline(text: string, router: ReturnType<typeof useRouter>): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = out.length;
    if (m[1] !== undefined) {
      const href = m[2];
      if (/^\/(?!\/)/.test(href))
        out.push(
          <a key={key} href={href} className="text-primary underline" onClick={(e) => { e.preventDefault(); router.history.push(href); }}>
            {m[1]}
          </a>,
        );
      else if (/^https:\/\//.test(href))
        out.push(<a key={key} href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline">{m[1]}</a>);
      else out.push(m[1]);
    } else if (m[3] !== undefined) out.push(<strong key={key}>{m[3]}</strong>);
    else out.push(<code key={key} className="rounded bg-muted px-1 text-xs">{m[4]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
