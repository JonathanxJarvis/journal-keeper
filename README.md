# Journal Keeper

An app for turning a shelf of handwritten journals into one organized, searchable
digital archive, ready for writing a book. It runs in a web browser on a Mac, PC,
tablet or phone and installs like an app. There is no server: pages are stored on
the device, and each photo is sent only to Claude (with your own API key) to be read.

## The four sections
- **Journals**: one cover per journal (for example seven), each with its own colour, page count and the years it spans. Open one to read it like a book: two pages side by side, turned with the arrow keys, the mouse wheel, a swipe, or the slider marked with years. Press **T** to show the typed text beside each page. **Arrange** shows every page as a tile to drag into the right order, or tick pages and move them to another journal. Search here finds words across all journals.
- **Timeline**: every page of every journal in date order in one viewer. Tap journal names to hide or show them.
- **Scan**: pick which journal you are scanning, then take photos, pick several at once, or drag files in on a computer. New pages go to the end of that journal, in the order the photos were taken.
- **Settings & help**: the Claude key, the PDF and text exports for the book, and backups.

## Dates and pages without a date
When Claude sees a date on a page it fills it in (a full date, a month or just a year). A page without a date is placed by the pages around it: "Between 3 March 1984 and 12 June 1984", "After …" or "Before …". Fix a date or the page order and every label updates. A date that is earlier than a date before it in the same journal is marked so it can be checked.

Star a page (**Save for the book**) to collect it; the "For the book" shelf and the exports gather starred pages.

## Using it on an older Mac
Use a recent **Chrome** if Safari is older than version 14.1. Pages stay in that browser on that Mac; to move pages between devices use Settings → Save a backup file, then Restore on the other device.

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

`index.html`, `styles.css`, `app.js` (storage, scanning, search, exports), `library.js` (the screens), `reader-view.js` (the side-by-side page viewer), `chrono.js` (dates and in-between labels), `claude-reader.js` (sends a page to Claude and reads back the text), `sw.js` (offline support),
`manifest.webmanifest` + `icons/` (Home Screen install), `fonts/` (Fraunces, Atkinson Hyperlegible, Caveat; SIL Open Font License),
`vendor/` (jsPDF 2.5.2 under MIT, SortableJS 1.15.6 under MIT, and the official Anthropic TypeScript SDK bundled for the browser, MIT).
