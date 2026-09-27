# Journal Keeper

A phone app for scanning handwritten journal pages, having Claude type them up,
searching them, and saving them as PDFs. It is a web app that installs to the
Home Screen. There is no server: pages are stored on the phone, and each photo
is sent only to Claude (with your own API key) to be read.

## What it does
- **Scan**: take a photo or pick several from the photo library. Trim the edges, turn the page, and choose a "clean scan" look that removes shadows.
- **Read handwriting**: Claude reads each page, cursive included, and returns the text plus a title, the date written and a few topics. The text can be corrected, typed, or dictated with the keyboard microphone.
- **Organize**: title, date written, notebook and tags on each page, plus a "checked" mark.
- **Search**: all words must match; "quoted phrases" match exactly; longer words also match when one letter is off, to forgive reading mistakes. Filter by notebook, year, tag, or pages still to check.
- **PDF**: one page, the search results, or everything, as a single PDF (photo of the page followed by its typed text).
- **Export text**: all text in one document, handy for writing the book.
- **Backup / restore**: one file with every page, for safekeeping or moving to a new phone.

## Setting up the Claude reader (paid per page)

Pages are read by Claude using your own Anthropic API key:

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

The app itself works offline; reading new pages needs internet, and pages wait until it is back.

## Good to know
- Claude reads cursive well but can still slip on faded or cramped words, so it is worth glancing over each page.
- Pages live only on that phone. Save a backup regularly (☰ → Save a backup file) to iCloud Drive, Google Drive or email.
- To try it on a computer: run `python3 -m http.server` in this folder and open http://localhost:8000.

## Files

`index.html`, `styles.css`, `app.js` (the app), `claude-reader.js` (sends a page to Claude and reads back the text), `sw.js` (offline support),
`manifest.webmanifest` + `icons/` (Home Screen install), `fonts/` (Fraunces, Atkinson Hyperlegible, Caveat; SIL Open Font License),
`vendor/` (jsPDF 2.5.2 under MIT, and the official Anthropic TypeScript SDK bundled for the browser, MIT).
