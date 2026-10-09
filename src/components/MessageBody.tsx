import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Remote images are blocked until the reader asks for them (they can track opens). */
function frameDoc(html: string, allowRemote: boolean): string {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: cid:" + (allowRemote ? ' https: http:' : '') + ';';
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    '<base target="_blank">' +
    '<style>html,body{margin:0;padding:0}body{display:flow-root;font:13.5px/1.6 "Space Grotesk",Arial,sans-serif;color:#18181b;overflow-wrap:anywhere}' +
    'img{max-width:100%;height:auto}blockquote{margin:0 0 0 4px;padding-left:12px;border-left:2px solid #ececf1;color:#6b6577}p{margin:0 0 10px}</style>' +
    '</head><body>' + html + '</body></html>'
  );
}

const hasRemoteImages = (html: string) => /<img[^>]+src\s*=\s*["']?https?:/i.test(html) || /url\(\s*["']?https?:/i.test(html);

/**
 * HTML mail is rendered in a sandboxed iframe: no scripts, no same-window
 * navigation, links open in a new tab. allow-same-origin is only there so the
 * parent can measure the content height; without allow-scripts nothing inside
 * the frame can run.
 */
function HtmlFrame({ html }: { html: string }) {
  const [remote, setRemote] = useState(false);
  const ref = useRef<HTMLIFrameElement>(null);
  const srcDoc = useMemo(() => frameDoc(html, remote), [html, remote]);
  const blocked = !remote && hasRemoteImages(html);

  const fit = useCallback(() => {
    const doc = ref.current?.contentDocument;
    // The body box (flow-root, so child margins stay inside) is the content height,
    // unlike documentElement.scrollHeight which never drops below the frame's own height.
    if (ref.current && doc?.body) ref.current.style.height = Math.ceil(doc.body.getBoundingClientRect().height) + 2 + 'px';
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let ro: ResizeObserver | undefined;
    const onLoad = () => {
      fit();
      const doc = el.contentDocument;
      if (!doc) return;
      doc.querySelectorAll('img').forEach(img => img.addEventListener('load', fit));
      if (typeof ResizeObserver !== 'undefined' && doc.body) {
        ro = new ResizeObserver(fit);
        ro.observe(doc.body);
      }
    };
    el.addEventListener('load', onLoad);
    return () => { el.removeEventListener('load', onLoad); ro?.disconnect(); };
  }, [srcDoc, fit]);

  return (
    <>
      {blocked && (
        <div className="images-note">
          <span>Remote images are hidden.</span>
          <button className="link-btn" onClick={() => setRemote(true)}>Show images</button>
        </div>
      )}
      <iframe
        ref={ref}
        className="msg-frame"
        title="Message content"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={srcDoc}
      />
    </>
  );
}

export function MessageBody({ text, html }: { text: string; html?: string }) {
  if (html) return <HtmlFrame html={html} />;
  return <div className="msg-text">{text}</div>;
}
