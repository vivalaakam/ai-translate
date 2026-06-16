// Script to generate a minimal valid EPUB with an embedded image for testing
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

// Minimal 1x1 red PNG (valid PNG, 67 bytes)
const MINIMAL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009001' +
  '2e00400000017452454402e1c0000000018494441407896360000010000' +
  '050001d5d8278f0000000049454e44ae426082',
  'hex'
);

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
    <dc:identifier id="BookId">urn:uuid:test-image-book-001</dc:identifier>
    <dc:title>Image Test Book</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="style" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
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
  <h1>Chapter with Image</h1>
  <p class="imagefp"><img src="images/cover.png" alt="Cover Image"/></p>
  <p>This paragraph has text after an image.</p>
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
      <li><a href="chapter1.xhtml">Chapter with Image</a></li>
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
zip.addFile('mimetype', Buffer.from(MIMETYPE, 'utf8'), '', 0);
zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER_XML, 'utf8'));
zip.addFile('OEBPS/content.opf', Buffer.from(CONTENT_OPF, 'utf8'));
zip.addFile('OEBPS/chapter1.xhtml', Buffer.from(CHAPTER1, 'utf8'));
zip.addFile('OEBPS/images/cover.png', MINIMAL_PNG, '', 8);
zip.addFile('OEBPS/nav.xhtml', Buffer.from(NAV, 'utf8'));
zip.addFile('OEBPS/style.css', Buffer.from(STYLE_CSS, 'utf8'));

if (!fs.existsSync(FIXTURES_DIR)) {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
}

const SAMPLE_EPUB = path.join(FIXTURES_DIR, 'sample-with-image.epub');
zip.writeZip(SAMPLE_EPUB);
console.log(`Created sample EPUB with image at: ${SAMPLE_EPUB}`);