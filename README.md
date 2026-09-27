# Journal Keeper

A free phone app for scanning handwritten journal pages, turning them into text,
searching them, and saving them as PDFs. It is a web app that installs to the
Home Screen. It has no server, no account, no subscription and no AI service:
the handwriting reader (Tesseract) runs on the phone itself, and all pages are
stored on the phone.

## What it does
- **Scan**: take a photo or pick several from the photo library. Trim the edges, turn the page, and choose a "clean scan" look that removes shadows.
- **Read handwriting**: each page is split into lines and read on the phone by TrOCR, an open handwriting-recognition model trained on real handwritten lines, cursive included. It downloads once (about 80 MB, from Hugging Face) and then works offline. A small quick reader (Tesseract) is kept for printed text and as a fallback. The text can be corrected, typed, or dictated with the keyboard microphone.
- **Learns from corrections**: every word fixed on a page is remembered and fixed automatically on later pages; words used often also correct near-misses.
- **Organize**: title, date written, notebook and tags on each page, plus a "checked" mark.
- **Search**: all words must match; "quoted phrases" match exactly; longer words also match when one letter is off, to forgive reading mistakes. Filter by notebook, year, tag, or pages still to check.
- **PDF**: one page, the search results, or everything, as a single PDF (photo of the page followed by its typed text).
- **Export text**: all text in one document, handy for writing the book.
- **Backup / restore**: one file with every page, for safekeeping or moving to a new phone.

## Claude reader (optional, paid per page)

For hard cursive, pages can be read by Claude using your own Anthropic API key:

1. Make an account at https://console.anthropic.com, add a card, buy prepaid credit (for example $20) and leave auto-reload off, so it can never charge more.
2. Create an API key (Settings > API keys) and copy it.
3. In the app: menu (☰) > Claude reader > paste the key > "Save and test the key".
4. Scan pages as usual. Each one is sent from the phone straight to Anthropic and the typed text, a title, the date and topics come back and are saved on the phone. "Read all unchecked pages with Claude" re-reads everything already scanned.

Sonnet 5 costs roughly 1 to 1.5 cents a page, Opus 5 roughly 2.5 to 3.5 cents. The menu shows what has been spent. If credit runs out or there is no internet, pages wait and carry on later. The key is stored only on the phone.

## Putting it online (free)
It is plain files, so any free static host works. Pick one:

**GitHub Pages**: create a public repository, upload everything in this folder
(keep the folders), then Settings → Pages → Deploy from branch → `main` / root.
The address will be `https://<username>.github.io/<repository>/`.

**Netlify**: sign up free at netlify.com, open "Add new site → Deploy manually"
and drag this folder onto the page.

It must be served over `https://` (both hosts do this) for the phone to install it.

## Installing on the phone
- **iPhone**: open the address in **Safari**, tap Share → **Add to Home Screen**.
  Always open it from the Home Screen icon: on iPhone the Home Screen app keeps
  its pages separately from Safari.
- **Android**: open the address in **Chrome**, tap ⋮ → **Install app** (or Add to Home screen).

The first visit downloads about 11 MB (the handwriting reader). After that it works offline.

## Good to know
- Handwriting reading is much better than a plain text scanner but not perfect, especially on slanted, cramped or faded lines. Plan on checking pages; tags and titles keep search useful either way.
- Pages live only on that phone. Save a backup regularly (☰ → Save a backup file) to iCloud Drive, Google Drive or email.
- To try it on a computer: run `python3 -m http.server` in this folder and open http://localhost:8000.

## Files

- `claude-reader.js` and `vendor/anthropic-sdk.mjs`: the Claude reader (official Anthropic SDK, bundled).
`index.html`, `styles.css`, `app.js` (the app), `reader.js` (line finding, learning), `htr-worker.js` (handwriting reader), `sw.js` (offline support),
`manifest.webmanifest` + `icons/` (Home Screen install), `vendor/` (Tesseract.js 5.1.1, jsPDF 2.5.2 and transformers.js 3.8.1, open source under Apache-2.0 and MIT), `lang/` (English reading data; named .wasm so every host serves it as a binary file).
