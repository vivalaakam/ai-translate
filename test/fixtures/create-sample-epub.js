// Script to generate a minimal valid EPUB for testing
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

const MIMETYPE = 'application/epub+zip';

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const CONTENT_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">urn:uuid:test-book-001</dc:identifier>
    <dc:title>Test Book</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="style" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
    <itemref idref="chapter2"/>
  </spine>
</package>`;

const CHAPTER1 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Chapter 1</title>
  <link rel="stylesheet" href="style.css"/>
</head>
<body>
  <h1>Chapter 1</h1>
  <p>Hello world</p>
  <p>This is a test paragraph.</p>
</body>
</html>`;

const CHAPTER2 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Chapter 2</title>
  <link rel="stylesheet" href="style.css"/>
</head>
<body>
  <h1>Chapter 2</h1>
  <p>Second chapter content.</p>
  <p>More text to translate.</p>
</body>
</html>`;

const NAV = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Table of Contents</title>
</head>
<body>
  <nav epub:type="toc">
    <ol>
      <li><a href="chapter1.xhtml">Chapter 1</a></li>
      <li><a href="chapter2.xhtml">Chapter 2</a></li>
    </ol>
  </nav>
</body>
</html>`;

const STYLE_CSS = `body { font-family: serif; margin: 2em; }
h1 { text-align: center; }
p { text-indent: 1.5em; }`;

// Create EPUB
const zip = new AdmZip();

// mimetype MUST be first entry and uncompressed
zip.addFile('mimetype', Buffer.from(MIMETYPE, 'utf8'), '', 0); // no compression

zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER_XML, 'utf8'));
zip.addFile('OEBPS/content.opf', Buffer.from(CONTENT_OPF, 'utf8'));
zip.addFile('OEBPS/chapter1.xhtml', Buffer.from(CHAPTER1, 'utf8'));
zip.addFile('OEBPS/chapter2.xhtml', Buffer.from(CHAPTER2, 'utf8'));
zip.addFile('OEBPS/nav.xhtml', Buffer.from(NAV, 'utf8'));
zip.addFile('OEBPS/style.css', Buffer.from(STYLE_CSS, 'utf8'));

if (!fs.existsSync(FIXTURES_DIR)) {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
}

const SAMPLE_EPUB = path.join(FIXTURES_DIR, 'sample.epub');
zip.writeZip(SAMPLE_EPUB);
console.log(`Created sample EPUB at: ${SAMPLE_EPUB}`);