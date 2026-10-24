# New hire onboarding

The page a new hire opens from the link HR sends, before they have a company account:
they confirm the e-mail the link was sent to, fill in the details asked, read and sign
the documents, and submit.

This repository holds the page only — HTML, CSS, one JavaScript module and a vendored copy
of PDF.js. It holds no data and no secret. Everything the page shows comes, after the
e-mail matched, from the onboarding API, and goes back there on submit.

| File | What it is |
|------|------------|
| `index.html` | The page: a content-security policy that allows nothing but this origin and the API, and the mount points the script fills. |
| `app.js` | The gate, the form, the documents drawn with PDF.js, the "Sign here" tab, the signature dialog, the submit. |
| `style.css` | HiveFin's light theme, written out. |
| `vendor/pdfjs/` | PDF.js 4.10.38 (`pdf.min.mjs` → `pdf.js`, `pdf.worker.min.mjs` → `pdf.worker.js`) from cdnjs, unmodified. SHA-256: `27fc2a05…190a9c` and `1baa1844…4be36`. |
| `assets/anduin-logo.png` | The Anduin logo in the header, a copy of `hivefin-app/public/anduin-padded-logo.png`. |
| `vendor/fonts/` | Qwigley, Kristi, Caveat, Zeyada (SIL Open Font License, `OFL.txt`) and Homemade Apple (Apache 2.0, `LICENSE-HomemadeApple.txt`): the styles offered for a typed signature. |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are. |

The source of truth is `onboarding/site/` in the HiveFin repository; this repository is
published from it with `onboarding/site/publish.sh`. Edit there, not here.
