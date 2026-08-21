// Convert Office documents (Word/Excel/PowerPoint/etc.) to PDF using LibreOffice
// in headless mode. LibreOffice must be installed on the server machine.
// Install on Windows:  winget install -e --id TheDocumentFoundation.LibreOffice
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OFFICE_EXTS = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf', '.txt'];

const CANDIDATES = [
  process.env.LIBREOFFICE_PATH,
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  '/usr/bin/soffice',
  '/usr/bin/libreoffice',
  '/opt/libreoffice/program/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
].filter(Boolean);

// Returns an absolute soffice path if found, else 'soffice' (relies on PATH),
// else null.
export function findSoffice() {
  for (const c of CANDIDATES) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return 'soffice'; // last resort: hope it's on PATH; exec will ENOENT if not
}

export function isOfficeFile(nameOrExt) {
  const ext = nameOrExt.startsWith('.') ? nameOrExt : path.extname(nameOrExt);
  return OFFICE_EXTS.includes(ext.toLowerCase());
}

// Convert inputPath -> a PDF in outDir. Resolves to the produced PDF path.
export function officeToPdf(inputPath, outDir) {
  return new Promise((resolve, reject) => {
    const soffice = findSoffice();
    // A unique user profile avoids "LibreOffice is already running" locks when
    // two conversions overlap.
    const profileDir = path.join(os.tmpdir(), 'lo_' + Date.now() + Math.random().toString(36).slice(2));
    const profile = 'file:///' + profileDir.replace(/\\/g, '/');
    const args = [
      '-env:UserInstallation=' + profile,
      '--headless', '--norestore', '--nologo',
      '--convert-to', 'pdf', '--outdir', outDir,
      inputPath,
    ];
    execFile(soffice, args, { timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
      if (err) {
        if (err.code === 'ENOENT') {
          return reject(Object.assign(new Error('LibreOffice not installed'), { code: 'NO_LIBREOFFICE' }));
        }
        return reject(new Error('Document conversion failed: ' + (stderr || err.message)));
      }
      const out = path.join(outDir, path.basename(inputPath, path.extname(inputPath)) + '.pdf');
      if (!fs.existsSync(out)) return reject(new Error('Conversion produced no PDF.'));
      resolve(out);
    });
  });
}
