// Minimal, safe markdown → DOM renderer. Builds nodes directly (never innerHTML), so user
// content can't inject markup. Supports: headings, paragraphs, lists, blockquotes, hr,
// **bold**, *italic*, `code`, [links](https://…).

export function renderMarkdown(src) {
  const root = document.createElement("div");
  root.className = "md";
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let para = [];
  const flush = () => {
    if (para.length) {
      const p = document.createElement("p");
      inline(p, para.join(" "));
      root.append(p);
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) {
      flush();
      i++;
    } else if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
      flush();
      const h = document.createElement(`h${Math.min(m[1].length + 1, 5)}`);
      inline(h, m[2]);
      root.append(h);
      i++;
    } else if (/^(\*\s*\*\s*\*|-\s*-\s*-)[\s*-]*$/.test(line)) {
      flush();
      root.append(document.createElement("hr"));
      i++;
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const li = document.createElement("li");
        let text = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) text += " " + lines[i++].trim();
        inline(li, text);
        list.append(li);
      }
      root.append(list);
    } else if (/^>\s?/.test(line)) {
      flush();
      const bq = document.createElement("blockquote");
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      bq.append(...renderMarkdown(buf.join("\n")).childNodes);
      root.append(bq);
    } else {
      para.push(line.trim());
      i++;
    }
  }
  flush();
  return root;
}

const INLINE = /(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*\s][^*]*)\*)|(_([^_\s][^_]*)_)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))/;

function inline(parent, text) {
  while (text) {
    const m = INLINE.exec(text);
    if (!m) {
      parent.append(text);
      return;
    }
    if (m.index) parent.append(text.slice(0, m.index));
    if (m[1] || m[3]) {
      const el = document.createElement("strong");
      inline(el, m[2] ?? m[4]);
      parent.append(el);
    } else if (m[5] || m[7]) {
      const el = document.createElement("em");
      inline(el, m[6] ?? m[8]);
      parent.append(el);
    } else if (m[9]) {
      const el = document.createElement("code");
      el.textContent = m[10];
      parent.append(el);
    } else if (m[11]) {
      const href = m[13];
      if (/^https?:\/\//i.test(href)) {
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        inline(a, m[12]);
        parent.append(a);
      } else parent.append(m[0]);
    }
    text = text.slice(m.index + m[0].length);
  }
}
