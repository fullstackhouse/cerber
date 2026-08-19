import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

marked.setOptions({ gfm: true, breaks: false });

/** Render trusted-ish markdown (AI output / PR content) safely. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const rendered = useMemo(() => {
    const raw = marked.parse(text ?? "", { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [text]);
  if (!text?.trim()) return null;
  return <div className={`md ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: rendered }} />;
}
