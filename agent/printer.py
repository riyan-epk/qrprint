"""Send a prepared PDF part to the physical printer.

Cross-platform:
  * Windows  -> SumatraPDF (silent print). Download the portable exe and put
               its path in config.json as "sumatra_path".
  * Linux/Pi -> CUPS `lp` command (the standard, most reliable kiosk path).
  * dry-run  -> just logs what it WOULD do (default, so you can test the whole
               system with no printer at all).

We never talk to printer hardware directly — we hand the OS a file + options.
"""
import os
import platform
import shutil
import subprocess
import sys


class PrintError(Exception):
    """reason is one of: paper_out, jam, offline, print_error."""
    def __init__(self, message, reason="print_error"):
        super().__init__(message)
        self.reason = reason


def print_part(part, options, cfg):
    """Print one part. part = {path, sides}. Raises PrintError on failure."""
    mode = cfg.get("print_mode", "dry")
    copies = max(1, int(options.get("copies", 1)))
    color = bool(options.get("color", False))
    sides = part["sides"]

    # Paper size: prefer the customer's choice, else the machine default.
    paper = options.get("paperSize") or cfg.get("paper_size", "A4")

    if mode == "dry":
        print(f"   [dry-run] would print {os.path.basename(part['path'])} "
              f"copies={copies} color={color} sides={sides} paper={paper}")
        return

    system = platform.system()
    if system == "Windows":
        # SumatraPDF prints to the printer's default paper size and scales to fit
        # ("fit"). For true multi-size selection, use a Linux/Pi + CUPS setup, or
        # set the printer's default paper to match.
        _print_windows(part["path"], copies, color, sides, cfg)
    else:
        _print_cups(part["path"], copies, color, sides, paper, cfg)


def _resolve_sumatra(cfg):
    """Find SumatraPDF: next to the agent, then configured path, then PATH,
    then common install locations."""
    p = cfg.get("sumatra_path", "SumatraPDF.exe")
    if p and os.path.isfile(p):
        return p
    # Bundled next to the agent .exe / script?
    base = os.path.dirname(sys.executable if getattr(sys, "frozen", False) else os.path.abspath(__file__))
    local = os.path.join(base, "SumatraPDF.exe")
    if os.path.isfile(local):
        return local
    found = shutil.which(p) or shutil.which("SumatraPDF")
    if found:
        return found
    for c in [
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Links\SumatraPDF.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\SumatraPDF\SumatraPDF.exe"),
        os.path.expandvars(r"%PROGRAMFILES%\SumatraPDF\SumatraPDF.exe"),
        os.path.expandvars(r"%PROGRAMFILES(X86)%\SumatraPDF\SumatraPDF.exe"),
    ]:
        if os.path.isfile(c):
            return c
    return p  # fall back; _run will raise a clear error if it's missing


def _print_windows(path, copies, color, sides, cfg):
    sumatra = _resolve_sumatra(cfg)
    settings = ["fit", "color" if color else "monochrome"]
    settings.append("duplexlong" if sides == "two-sided" else "simplex")
    if copies > 1:
        settings.append(f"{copies}x")
    printer = cfg.get("printer_name")  # None => default printer
    cmd = [sumatra, "-silent"]
    if printer:
        cmd += ["-print-to", printer]
    else:
        cmd += ["-print-to-default"]
    cmd += ["-print-settings", ",".join(settings), path]
    _run(cmd)


def _print_cups(path, copies, color, sides, paper, cfg):
    lp_sides = "two-sided-long-edge" if sides == "two-sided" else "one-sided"
    cmd = ["lp"]
    printer = cfg.get("printer_name")
    if printer:
        cmd += ["-d", printer]
    cmd += ["-n", str(copies),
            "-o", f"sides={lp_sides}",
            "-o", f"ColorModel={'RGB' if color else 'Gray'}",
            "-o", "fit-to-page",
            "-o", f"media={paper}",
            path]
    _run(cmd)


def _run(cmd):
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except FileNotFoundError:
        raise PrintError(f"Print command not found: {cmd[0]}", "offline")
    except subprocess.TimeoutExpired:
        raise PrintError("Printer did not respond in time", "offline")

    out = ((result.stdout or "") + (result.stderr or "")).lower()
    if result.returncode != 0 or _looks_like_error(out):
        raise PrintError(f"Print failed: {out.strip() or 'unknown error'}", _classify(out))


def _looks_like_error(text):
    return any(k in text for k in ("error", "not accepting", "unable"))


def _classify(text):
    if "paper" in text or "empty" in text or "no media" in text:
        return "paper_out"
    if "jam" in text:
        return "jam"
    if "offline" in text or "not connect" in text or "unreachable" in text:
        return "offline"
    return "print_error"
