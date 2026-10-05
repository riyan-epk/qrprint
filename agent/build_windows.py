"""Build the Windows agent package that is shipped to new shops.

    python agent/build_windows.py

Makes  qrprint-agent-windows.zip  in the project folder, containing:
    qrprint-agent.exe   the agent (Python + pypdf bundled, no install needed)
    SumatraPDF.exe      the PDF printer it drives (copied from agent/vendor/)
    README-FIRST.txt    setup guide for the shopkeeper

Needs (on the build PC only): Windows, Python 3.10+, internet the first time
(pip installs PyInstaller + pypdf), and the portable SumatraPDF.exe in
agent/vendor/ (https://www.sumatrapdfreader.org/download-free-pdf-viewer).
"""
import hashlib
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

AGENT = Path(__file__).resolve().parent
ROOT = AGENT.parent
BUILD = AGENT / "build"
RELEASE = AGENT / "release" / "QRPrint-Agent"
ZIP_PATH = ROOT / "qrprint-agent-windows.zip"


def read_version():
    m = re.search(r'^VERSION\s*=\s*"([\d.]+)"', (AGENT / "agent.py").read_text(encoding="utf-8"), re.M)
    if not m:
        sys.exit("VERSION not found in agent.py")
    return m.group(1)


def read_contact():
    """The same support contact the website shows (server/config.js defaults)."""
    js = (ROOT / "server" / "config.js").read_text(encoding="utf-8")
    email = re.search(r"CONTACT_EMAIL \|\| '([^']+)'", js)
    phone = re.search(r"CONTACT_WHATSAPP \|\| '([^']+)'", js)
    return (email.group(1) if email else "your provider"), (phone.group(1) if phone else "")


def ensure(module, package):
    try:
        __import__(module)
    except ImportError:
        print(f">> Installing {package} ...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--upgrade", package])


def version_file(version):
    parts = (version.split(".") + ["0", "0", "0"])[:4]
    nums = ", ".join(str(int(p)) for p in parts)
    return f"""VSVersionInfo(
  ffi=FixedFileInfo(filevers=({nums}), prodvers=({nums}), mask=0x3f, flags=0x0,
                    OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([StringTable('040904B0', [
      StringStruct('CompanyName', 'QRPrint'),
      StringStruct('FileDescription', 'QRPrint Print Agent'),
      StringStruct('FileVersion', '{version}'),
      StringStruct('InternalName', 'qrprint-agent'),
      StringStruct('OriginalFilename', 'qrprint-agent.exe'),
      StringStruct('ProductName', 'QRPrint Agent'),
      StringStruct('ProductVersion', '{version}')])]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
"""


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    if sys.platform != "win32":
        sys.exit("Build the Windows agent on Windows.")
    sumatra = AGENT / "vendor" / "SumatraPDF.exe"
    if not sumatra.exists():
        sys.exit(f"Missing {sumatra}\nDownload the portable SumatraPDF (64-bit) and save it there as SumatraPDF.exe.")

    version = read_version()
    email, whatsapp = read_contact()
    print(f">> Building QRPrint Agent {version}")
    ensure("PyInstaller", "pyinstaller")
    ensure("pypdf", "pypdf")

    shutil.rmtree(BUILD, ignore_errors=True)
    BUILD.mkdir(parents=True)
    (BUILD / "version.txt").write_text(version_file(version), encoding="utf-8")

    subprocess.check_call([
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onefile", "--console",
        "--name", "qrprint-agent",
        "--icon", str(AGENT / "assets" / "qrprint.ico"),
        "--version-file", str(BUILD / "version.txt"),
        "--distpath", str(BUILD / "dist"),
        "--workpath", str(BUILD / "work"),
        "--specpath", str(BUILD),
        "--paths", str(AGENT),
        str(AGENT / "agent.py"),
    ])

    exe = BUILD / "dist" / "qrprint-agent.exe"
    out = subprocess.run([str(exe), "--version"], capture_output=True, text=True, timeout=60).stdout.strip()
    if out != version:
        sys.exit(f"Built exe reports version {out!r}, expected {version!r}")

    # Assemble the folder the shop receives.
    shutil.rmtree(RELEASE.parent, ignore_errors=True)
    RELEASE.mkdir(parents=True)
    shutil.copy2(exe, RELEASE / "qrprint-agent.exe")
    shutil.copy2(sumatra, RELEASE / "SumatraPDF.exe")
    readme = (AGENT / "README-FIRST.txt").read_text(encoding="utf-8")
    readme = readme.replace("{VERSION}", version).replace("{EMAIL}", email).replace("{WHATSAPP}", whatsapp)
    (RELEASE / "README-FIRST.txt").write_text(readme.replace("\n", "\r\n"), encoding="utf-8", newline="")

    if ZIP_PATH.exists():
        ZIP_PATH.unlink()
    with zipfile.ZipFile(ZIP_PATH, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in sorted(RELEASE.iterdir()):
            z.write(f, f"QRPrint-Agent/{f.name}")

    print("\n>> Done")
    print(f"   {ZIP_PATH}  ({ZIP_PATH.stat().st_size / 1048576:.1f} MB)")
    print(f"   qrprint-agent.exe {version}  sha256 {sha256(RELEASE / 'qrprint-agent.exe')}")


if __name__ == "__main__":
    main()
