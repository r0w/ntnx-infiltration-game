import { useEffect, useRef } from 'react';
import grapesjs, { type Editor } from 'grapesjs';
import presetNewsletter from 'grapesjs-preset-newsletter';
import 'grapesjs/dist/css/grapes.min.css';

/**
 * GrapesJS-based visual editor for the participant emails (/admin Emails
 * tab), lazy-loaded so the ~1MB editor only ships when the tab uses it.
 *
 * GrapesJS owns ONLY the body content: the template's doctype + <head>
 * (title, Outlook mso font styles) and the <body> tag attributes are
 * split off before import and stitched back around the preset's
 * CSS-inlined export. That keeps the parts GrapesJS would drop intact,
 * while accepting that the body markup becomes GrapesJS's re-rendering
 * (the operator chose the studio model over byte-fidelity).
 *
 * The exported draft flows up through onChange on every edit (debounced)
 * — the parent keeps it as the source of truth for source/preview views
 * and for sending.
 */

interface Shell {
  head: string;
  htmlAttrs: string;
  bodyAttrs: string;
}

function splitShell(html: string): { shell: Shell; bodyInner: string } {
  const headMatch = html.match(/<head[^>]*>[\s\S]*?<\/head>/i);
  const htmlMatch = html.match(/<html([^>]*)>/i);
  const bodyMatch = html.match(/<body([^>]*)>([\s\S]*)<\/body>/i);
  return {
    shell: {
      head: headMatch?.[0] ?? '<head><meta charset="utf-8"></head>',
      htmlAttrs: htmlMatch?.[1] ?? '',
      bodyAttrs: bodyMatch?.[1] ?? '',
    },
    bodyInner: bodyMatch?.[2] ?? html,
  };
}

function reassemble(shell: Shell, bodyInner: string): string {
  // The newsletter preset's inlined export wraps its output in its own
  // <body> tag — unwrap it, the shell provides the original one.
  const m = bodyInner.match(/^\s*<body[^>]*>([\s\S]*)<\/body>\s*$/i);
  const inner = m ? m[1] : bodyInner;
  return `<!doctype html>\n<html${shell.htmlAttrs}>\n${shell.head}\n<body${shell.bodyAttrs}>\n${inner}\n</body>\n</html>\n`;
}

export default function EmailStudio({
  html,
  onChange,
}: {
  /** Full email document loaded into the studio at mount. Later edits
   *  flow OUT through onChange only — remount (key) to load new content. */
  html: string;
  onChange: (html: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  // Mount-time snapshot: the editor is uncontrolled after init.
  const initialHtml = useRef(html);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;
    const { shell, bodyInner } = splitShell(initialHtml.current);

    const editor = grapesjs.init({
      container: containerRef.current,
      // Concrete unit on purpose: the default '100%' resolves to 0 inside
      // our flex-column tab layout and the canvas iframe collapses.
      height: '72vh',
      storageManager: false,
      plugins: [presetNewsletter],
      pluginsOpts: {
        [presetNewsletter as unknown as string]: {
          // We reassemble the full document ourselves.
          inlineCss: true,
        },
      },
    });
    editor.setComponents(bodyInner);
    editorRef.current = editor;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const exportDraft = () => {
      // The newsletter preset's command returns the body markup with the
      // style-manager CSS inlined — email-client-safe.
      const inlined = editor.runCommand('gjs-get-inlined-html') as unknown as string;
      if (typeof inlined === 'string' && inlined.trim()) {
        onChangeRef.current(reassemble(shell, inlined));
      }
    };
    const onUpdate = () => {
      clearTimeout(timer);
      timer = setTimeout(exportDraft, 400);
    };
    editor.on('update', onUpdate);

    return () => {
      clearTimeout(timer);
      editor.off('update', onUpdate);
      editor.destroy();
      editorRef.current = null;
    };
  }, []);

  return <div className="admin-emails-studio" ref={containerRef} />;
}
