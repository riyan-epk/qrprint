"""QRPrint shop-side print agent.

Runs next to the printer (on the shop's Windows PC or a Raspberry Pi). It polls
the server for PAID jobs, prepares the PDF, prints it, and reports the result.
Because it only ever handles already-paid jobs, a suspended subscription never
strands a paying customer.

Usage (source):  pip install -r requirements.txt  &&  python agent.py
Usage (.exe):    double-click qrprint-agent.exe

Options:
    --setup              enter / change the agent key
    --autostart on|off   start (or stop starting) with Windows
    --test               print a test page and exit
    --server URL         use a different server (advanced)
    --version            show the version and exit
"""
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

from pdftools import prepare
from printer import print_part, PrintError

VERSION = "2.0.0"
DEFAULT_SERVER = "https://print.mystay.live"
IS_WINDOWS = platform.system() == "Windows"
FROZEN = getattr(sys, "frozen", False)

# When bundled as a .exe (PyInstaller), files live next to the executable, not
# in the temporary unpack folder.
HERE = os.path.dirname(sys.executable) if FROZEN else os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
LOG_PATH = os.path.join(HERE, "agent.log")
WORK_DIR = os.path.join(HERE, ".work")

# A browser-like User-Agent so Cloudflare (Bot Fight Mode) doesn't block the
# agent's requests as "bot traffic" (HTTP 403 through the tunnel otherwise).
USER_AGENT = f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) QRPrintAgent/{VERSION}"


# --- output + log file --------------------------------------------------------

def say(msg=""):
    """Print to the window and append to agent.log (kept under ~1 MB)."""
    print(msg, flush=True)
    try:
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > 1_000_000:
            os.replace(LOG_PATH, LOG_PATH + ".1")
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + str(msg) + "\n")
    except OSError:
        pass


def fatal(msg):
    """Show a clear message and keep the window open long enough to read it."""
    say("")
    say("!! " + msg)
    if FROZEN:
        try:
            input("\nPress Enter to close this window...")
        except EOFError:
            pass
    sys.exit(1)


def set_title(text):
    if IS_WINDOWS:
        try:
            import ctypes
            ctypes.windll.kernel32.SetConsoleTitleW(text)
        except Exception:
            pass


# --- this computer ------------------------------------------------------------

def machine_id():
    """A stable, anonymous fingerprint of this PC. The server links the shop's
    agent key to it, so a copied key doesn't work on another computer."""
    raw = ""
    try:
        if IS_WINDOWS:
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography",
                                0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
                raw = winreg.QueryValueEx(k, "MachineGuid")[0]
        else:
            for p in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
                if os.path.exists(p):
                    with open(p) as f:
                        raw = f.read().strip()
                    break
    except Exception:
        raw = ""
    if not raw:
        import uuid
        raw = str(uuid.getnode())
    return hashlib.sha256(("qrprint:" + raw).encode()).hexdigest()[:32]


_mutex = None


def single_instance():
    """Refuse to start twice on the same PC (two windows = confusing)."""
    global _mutex
    if not IS_WINDOWS:
        return True
    try:
        import ctypes
        _mutex = ctypes.windll.kernel32.CreateMutexW(None, False, "Local\\QRPrintAgent")
        return ctypes.windll.kernel32.GetLastError() != 183  # ERROR_ALREADY_EXISTS
    except Exception:
        return True


RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_NAME = "QRPrint Agent"


def set_autostart(on):
    """Start with Windows (current user — no admin rights needed)."""
    if not IS_WINDOWS:
        say("Auto-start is only available on Windows. On Linux use the systemd service.")
        return False
    if not FROZEN:
        say("Auto-start is set up from qrprint-agent.exe (not when running agent.py).")
        return False
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
            if on:
                winreg.SetValueEx(k, RUN_NAME, 0, winreg.REG_SZ, f'"{sys.executable}"')
            else:
                try:
                    winreg.DeleteValue(k, RUN_NAME)
                except FileNotFoundError:
                    pass
        return True
    except OSError as e:
        say(f"Could not change auto-start: {e}")
        return False


def autostart_enabled():
    if not (IS_WINDOWS and FROZEN):
        return False
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            return bool(winreg.QueryValueEx(k, RUN_NAME)[0])
    except OSError:
        return False


# --- printer status (Windows) -------------------------------------------------

# Win32_Printer.DetectedErrorState -> message. "blocking" problems pause printing
# so jobs wait in the queue instead of disappearing into a stuck printer.
PRINTER_ERRORS = {
    3: ("low on paper", False), 4: ("no paper", True), 5: ("low toner", False),
    6: ("no toner", True), 7: ("door open", True), 8: ("paper jam", True),
    9: ("offline", True), 10: ("needs service", True), 11: ("output tray full", True),
}
_printer_cache = {"at": 0, "value": None}


def printer_status(cfg):
    """{'name', 'online', 'issue', 'blocking'} for the configured (or default)
    printer, or None when it can't be read. Checked about once a minute."""
    if not IS_WINDOWS:
        return None
    now = time.time()
    # Re-check sooner while there's a problem, so printing resumes quickly.
    ttl = 15 if (_printer_cache["value"] or {}).get("blocking") else 60
    if now - _printer_cache["at"] < ttl:
        return _printer_cache["value"]
    _printer_cache["at"] = now
    name = (cfg.get("printer_name") or "").replace("'", "''")
    where = f"$_.Name -eq '{name}'" if name else "$_.Default -eq $true"
    script = (
        f"$p = Get-CimInstance Win32_Printer | Where-Object {{ {where} }} | Select-Object -First 1; "
        "if ($p) { '{0}|{1}|{2}|{3}' -f $p.Name, $p.WorkOffline, $p.PrinterStatus, $p.DetectedErrorState }"
    )
    value = None
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout.strip()
        if out:
            pname, offline, status, err = (out.split("|") + ["", "", "", ""])[:4]
            err = int(err) if err.strip().isdigit() else 0
            issue, blocking = PRINTER_ERRORS.get(err, (None, False))
            is_offline = offline.strip().lower() == "true" or status.strip() == "7" or err == 9
            if is_offline:
                issue, blocking = "offline", True
            value = {"name": pname, "online": not is_offline, "issue": issue, "blocking": blocking}
        else:
            value = {"name": None, "online": False, "issue": "no printer found", "blocking": False}
    except Exception:
        value = None
    _printer_cache["value"] = value
    return value


# --- config -------------------------------------------------------------------

def load_config():
    if not os.path.exists(CONFIG_PATH):
        return None
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError) as e:
        fatal(f"config.json could not be read ({e}). Delete it and start the agent again to re-enter your key.")
    cfg.setdefault("server_url", DEFAULT_SERVER)
    cfg.setdefault("poll_seconds", 3)
    cfg.setdefault("print_mode", "live")
    cfg.setdefault("pause_on_printer_problem", True)
    cfg["server_url"] = cfg["server_url"].rstrip("/")
    cfg["machine"] = machine_id()
    return cfg


def save_config(cfg):
    data = {k: v for k, v in cfg.items() if k != "machine"}
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def ask(prompt, default=""):
    try:
        return input(prompt).strip() or default
    except EOFError:
        return default


def first_run_setup(existing=None, server=None):
    """Ask for the agent key, check it with the server, offer auto-start."""
    say("=" * 56)
    say(f"  QRPrint Agent {VERSION} - setup")
    say("=" * 56)
    say("Your provider gave you an AGENT KEY when they created your shop.")
    cfg = dict(existing or {})
    cfg.setdefault("print_mode", "live")
    cfg.setdefault("printer_name", None)
    cfg.setdefault("paper_size", "A4")
    cfg.setdefault("sumatra_path", "SumatraPDF.exe")
    cfg.setdefault("poll_seconds", 3)
    cfg.setdefault("pause_on_printer_problem", True)
    cfg["server_url"] = (server or cfg.get("server_url") or DEFAULT_SERVER).rstrip("/")
    cfg["machine"] = machine_id()

    while True:
        try:
            key = input("\nPaste your AGENT KEY here and press Enter: ").strip()
        except EOFError:
            fatal("No agent key was entered. Start the agent again and paste your key.")
        if not key:
            continue
        cfg["agent_key"] = key
        say("Checking the key with the server...")
        try:
            who = api(cfg, "GET", "/api/agent/whoami")
            say(f"OK - connected to: {who.get('shop', {}).get('name', 'your shop')}")
            break
        except urllib.error.HTTPError as e:
            if e.code == 401:
                say("That key was not accepted. Check it (copy it again from your provider) and try once more.")
                continue
            if e.code == 409:
                say("This key is already linked to another computer. Ask your provider to 'Unlink PC', then try again.")
                continue
            if e.code == 404:   # older server without the check: accept the key
                break
            say(f"The server answered with an error ({e.code}). The key is saved; the agent will keep retrying.")
            break
        except Exception as e:
            say(f"Could not reach the server right now ({e}). The key is saved; the agent will keep retrying.")
            break

    save_config(cfg)
    say("Saved.")
    if IS_WINDOWS and FROZEN:
        a = ask("\nStart QRPrint Agent automatically when this PC turns on? [Y/n]: ", "y").lower()
        if a.startswith("y") and set_autostart(True):
            say("Auto-start is ON. (Turn off: qrprint-agent.exe --autostart off)")
    say("")
    return cfg


# --- server API ---------------------------------------------------------------

def api(cfg, method, path, data=None):
    headers = {"x-agent-key": cfg["agent_key"], "x-agent-machine": cfg["machine"], "User-Agent": USER_AGENT}
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(cfg["server_url"] + path, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read() or b"{}")


def download(cfg, path, dest):
    req = urllib.request.Request(
        cfg["server_url"] + path,
        headers={"x-agent-key": cfg["agent_key"], "x-agent-machine": cfg["machine"], "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=60) as resp, open(dest, "wb") as f:
        shutil.copyfileobj(resp, f)


def heartbeat(cfg, status):
    printer = {"online": True}
    if status:
        printer = {"online": status["online"], "name": status["name"], "issue": status["issue"]}
    try:
        api(cfg, "POST", "/api/agent/heartbeat", {
            "printer": printer,
            "agent": {"version": VERSION, "os": f"{platform.system()} {platform.release()}"},
        })
    except Exception:
        pass


# --- jobs ---------------------------------------------------------------------

def keepalive(cfg, job_id, stop):
    """Tell the server we're still working on this job, so a long print isn't
    mistaken for a stopped agent and re-queued (which would print it twice)."""
    while not stop.is_set():
        try:
            api(cfg, "POST", f"/api/agent/jobs/{job_id}/progress", {})
        except Exception:
            pass
        stop.wait(20)


def process_job(cfg, job):
    stop = threading.Event()
    threading.Thread(target=keepalive, args=(cfg, job["id"], stop), daemon=True).start()
    try:
        run_job(cfg, job)
    finally:
        stop.set()


def run_job(cfg, job):
    opts = job["options"]
    desc = f"{opts.get('copies', 1)}x, {'colour' if opts.get('color') else 'B&W'}"
    say(f"-> Printing: {job['originalName']} ({job['pages']} page(s), {desc})")
    workdir = os.path.join(WORK_DIR, job["id"])
    os.makedirs(workdir, exist_ok=True)
    src = os.path.join(workdir, "source.pdf")

    try:
        download(cfg, job["fileUrl"], src)
    except Exception as e:
        report(cfg, job["id"], "failed", "print_error", f"download failed: {e}")
        return

    try:
        parts, _ = prepare(src, opts, workdir)
        for part in parts:
            print_part(part, opts, cfg)
    except PrintError as e:
        say(f"   ! print problem ({e.reason}): {e}")
        report(cfg, job["id"], "failed", e.reason, str(e))
        return
    except Exception as e:
        say(f"   ! unexpected error: {e}")
        report(cfg, job["id"], "failed", "print_error", str(e))
        return
    finally:
        # The customer's file never stays on this PC.
        shutil.rmtree(workdir, ignore_errors=True)

    report(cfg, job["id"], "printed")
    say("   done.")


def report(cfg, job_id, result, reason=None, detail=None):
    # Retry: if the server never hears "printed", it re-queues the job and it
    # would print a second time.
    tries = 5
    for attempt in range(1, tries + 1):
        try:
            api(cfg, "POST", f"/api/agent/jobs/{job_id}/report",
                {"result": result, "reason": reason, "detail": detail})
            return
        except urllib.error.HTTPError as e:
            if e.code < 500:  # job gone / bad key: retrying won't help
                say(f"   ! could not report result: {e}")
                return
            err = e
        except Exception as e:
            err = e
        say(f"   ! could not report result (try {attempt}/{tries}): {err}")
        if attempt < tries:
            time.sleep(3 * attempt)


# --- test page ----------------------------------------------------------------

def test_page(cfg):
    """Print a one-page test so the shop can check the printer setup."""
    os.makedirs(WORK_DIR, exist_ok=True)
    path = os.path.join(WORK_DIR, "test-page.pdf")
    lines = ["QRPrint test page", f"Agent {VERSION}", time.strftime("%d %b %Y %H:%M"),
             "If you can read this, printing works."]
    text = "BT /F1 28 Tf 72 760 Td (" + lines[0] + ") Tj /F1 14 Tf " + \
        " ".join(f"0 -28 Td ({line}) Tj" for line in lines[1:]) + " ET"
    objs = [
        "<</Type/Catalog/Pages 2 0 R>>",
        "<</Type/Pages/Kids[3 0 R]/Count 1>>",
        "<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R"
        "/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>>>",
        f"<</Length {len(text)}>>stream\n{text}\nendstream",
    ]
    out, offsets = "%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj{o}endobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offsets)
    out += f"trailer<</Size {len(objs) + 1}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF"
    with open(path, "wb") as f:   # binary: the xref offsets are byte counts
        f.write(out.encode("latin-1"))
    say("Printing a test page...")
    try:
        print_part({"path": path, "sides": "one-sided"}, {"copies": 1}, cfg)
        say("Sent to the printer. Check that a page came out.")
    except PrintError as e:
        say(f"Test page failed ({e.reason}): {e}")
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


# --- main loop ----------------------------------------------------------------

def run(cfg):
    shop = "your shop"
    try:
        shop = api(cfg, "GET", "/api/agent/whoami").get("shop", {}).get("name", shop)
    except Exception:
        pass
    status = printer_status(cfg)
    set_title(f"QRPrint Agent - {shop}")
    say(f"QRPrint Agent {VERSION}  |  shop: {shop}  |  server: {cfg['server_url']}")
    if cfg["print_mode"] != "live":
        say("   (TEST MODE: print_mode is 'dry' in config.json - nothing will be printed)")
    if status:
        say(f"Printer: {status['name'] or 'not found'}" + (f"  ({status['issue']})" if status["issue"] else ""))
    say(f"Auto-start with Windows: {'ON' if autostart_enabled() else 'off'}" if IS_WINDOWS and FROZEN else "")
    say("Waiting for paid jobs. Keep this window open (you can minimise it).\n")

    last_beat = 0
    backoff = 0          # grows when the server is unreachable, resets on success
    paused_msg = None
    while True:
        try:
            status = printer_status(cfg)
            now = time.time()
            if now - last_beat > 30:
                heartbeat(cfg, status)
                last_beat = now

            # A clear printer problem (no paper, jam, offline): don't take jobs —
            # they wait safely in the queue and print once it's fixed.
            if cfg.get("pause_on_printer_problem", True) and status and status["blocking"]:
                if paused_msg != status["issue"]:
                    say(f"   Printer problem: {status['issue']}. Waiting - jobs stay in the queue until it's fixed.")
                    paused_msg = status["issue"]
                time.sleep(10)
                continue
            if paused_msg:
                say("   Printer is ready again.")
                paused_msg = None

            resp = api(cfg, "GET", "/api/agent/jobs/next")
            backoff = 0  # reachable again
            job = resp.get("job")
            if job:
                process_job(cfg, job)
                continue  # grab the next one immediately
        except urllib.error.HTTPError as e:
            if e.code == 401:
                say("   ! The server rejected the agent key. Run 'qrprint-agent.exe --setup' to enter the new key.")
                time.sleep(30)
            elif e.code == 409:
                say("   ! This agent key is linked to another computer. Ask your provider to 'Unlink PC'.")
                time.sleep(60)
            else:
                say(f"   (server error {e.code}) - retrying")
        except urllib.error.URLError as e:
            backoff = min(60, (backoff or cfg["poll_seconds"]) * 2)
            say(f"   (server unreachable: {e.reason}) - retrying in {backoff}s")
            time.sleep(backoff)
            continue
        time.sleep(cfg["poll_seconds"])


def main():
    args = sys.argv[1:]
    if "--version" in args:
        print(VERSION)
        return
    server = args[args.index("--server") + 1] if "--server" in args and args.index("--server") + 1 < len(args) else None

    if "--autostart" in args:
        i = args.index("--autostart")
        on = (args[i + 1] if i + 1 < len(args) else "on").lower() != "off"
        if set_autostart(on):
            say(f"Auto-start is {'ON' if on else 'OFF'}.")
        return

    cfg = load_config()
    if cfg is None or "--setup" in args or server:
        cfg = first_run_setup(cfg, server)
    if not cfg.get("agent_key") or "PASTE" in cfg.get("agent_key", ""):
        cfg = first_run_setup(cfg, server)

    if "--test" in args:
        test_page(cfg)
        if FROZEN:
            ask("\nPress Enter to close...")
        return

    if not single_instance():
        fatal("QRPrint Agent is already running on this PC (check the taskbar). Only one copy is needed.")

    shutil.rmtree(WORK_DIR, ignore_errors=True)   # leftovers from a crash or power cut

    # Never give up: an unexpected error is logged and the agent starts again.
    while True:
        try:
            run(cfg)
        except KeyboardInterrupt:
            say("\nStopped.")
            return
        except Exception as e:
            say(f"   ! unexpected problem: {e!r} - restarting in 10 seconds")
            time.sleep(10)


if __name__ == "__main__":
    main()
