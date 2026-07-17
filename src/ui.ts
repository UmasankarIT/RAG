/**
 * The web UI, served at GET /. A single self-contained page: ask a question,
 * see the full answer and the cited page images. No build step, no framework.
 */
export const indexHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>L2G RAG</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      max-width: 820px; margin: 0 auto; padding: 24px;
      line-height: 1.5; background: Canvas; color: CanvasText;
    }
    h1 { font-size: 1.4rem; margin: 0 0 4px; }
    .sub { opacity: 0.7; margin: 0 0 20px; font-size: 0.9rem; }
    form { display: flex; gap: 8px; margin-bottom: 20px; }
    textarea {
      flex: 1; padding: 10px 12px; font-size: 1rem; border-radius: 8px;
      border: 1px solid rgba(128,128,128,0.4); background: Field; color: FieldText;
      resize: vertical; min-height: 48px; font-family: inherit;
    }
    button {
      padding: 10px 18px; font-size: 1rem; border-radius: 8px; border: 0;
      background: #2563eb; color: #fff; cursor: pointer; white-space: nowrap;
    }
    button:disabled { opacity: 0.5; cursor: default; }
    .examples { margin-bottom: 20px; font-size: 0.85rem; }
    .examples button {
      background: transparent; color: #2563eb; border: 1px solid rgba(37,99,235,0.4);
      padding: 4px 10px; margin: 3px 4px 0 0; font-size: 0.8rem;
    }
    #status { opacity: 0.7; font-style: italic; }
    .answer {
      white-space: pre-wrap; background: rgba(128,128,128,0.08);
      padding: 16px; border-radius: 10px; margin-bottom: 20px;
    }
    .answer strong { font-weight: 700; }
    h2 { font-size: 1rem; margin: 24px 0 10px; }
    .cites { display: flex; flex-wrap: wrap; gap: 12px; }
    .cite {
      border: 1px solid rgba(128,128,128,0.3); border-radius: 10px;
      padding: 8px; width: 160px; text-decoration: none; color: inherit;
    }
    .cite img { width: 100%; border-radius: 6px; display: block; background: #fff; }
    .cite .label { font-size: 0.8rem; margin-top: 6px; opacity: 0.85; }
  </style>
</head>
<body>
  <h1>L2G RAG</h1>
  <p class="sub">Ask a question about the ingested course material. Answers come from the actual page images.</p>

  <form id="ask">
    <textarea id="q" placeholder="e.g. What is neovascular glaucoma and what causes it?"></textarea>
    <button type="submit" id="go">Ask</button>
  </form>

  <div class="examples">
    <button data-q="What is neovascular glaucoma and what causes it?">neovascular glaucoma</button>
    <button data-q="Is diabetes a risk factor for glaucoma?">diabetes &amp; glaucoma</button>
    <button data-q="How is aqueous misdirection syndrome treated?">aqueous misdirection</button>
    <button data-q="What was the success rate of the ExPress device at one year?">ExPress success rate</button>
  </div>

  <div id="status"></div>
  <div id="result"></div>

  <script>
    const form = document.getElementById('ask');
    const q = document.getElementById('q');
    const go = document.getElementById('go');
    const status = document.getElementById('status');
    const result = document.getElementById('result');

    // tiny markdown: **bold** only; everything else is plain text (pre-wrap keeps line breaks)
    function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function fmt(s) { return esc(s).replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>'); }

    for (const b of document.querySelectorAll('.examples button')) {
      b.onclick = () => { q.value = b.dataset.q; form.requestSubmit(); };
    }

    form.onsubmit = async (e) => {
      e.preventDefault();
      const question = q.value.trim();
      if (!question) return;
      go.disabled = true;
      status.textContent = 'Thinking…';
      result.innerHTML = '';
      try {
        const res = await fetch('/query', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question }),
        });
        const data = await res.json();
        status.textContent = '';
        let html = '<div class="answer">' + fmt(data.answer || '(no answer)') + '</div>';
        if (data.citations && data.citations.length) {
          html += '<h2>Source pages</h2><div class="cites">';
          for (const c of data.citations) {
            const src = encodeURIComponent(c.sourceId);
            const pg = c.pageNumber;
            const label = (c.sourceTitle || c.sourceId) + ', page ' + pg;
            const img = '/image?sourceId=' + src + '&pageNumber=' + pg;
            html += '<a class="cite" href="' + img + '" target="_blank">'
                  + '<img src="' + img + '" alt="page ' + pg + '" />'
                  + '<div class="label">' + esc(label) + '</div></a>';
          }
          html += '</div>';
        }
        result.innerHTML = html;
      } catch (err) {
        status.textContent = 'Error: ' + err;
      } finally {
        go.disabled = false;
      }
    };
  </script>
</body>
</html>`;
