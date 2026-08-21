"""QRPrint shop-side print agent.

Runs next to the printer (on a Raspberry Pi or the shop's Windows PC). It polls
the server for PAID jobs, prepares the PDF, prints it, and reports the result.
Because it only ever handles already-paid jobs, a suspended subscription never
strands a paying customer.

Usage:
    1. pip install -r requirements.txt
    2. copy config.example.json -> config.json and edit it
    3. python agent.py
"""
import json
import os
import shutil
import sys
import time
import urllib.request
import urllib.error

from pdftools import prepare
from printer import print_part, PrintError

# When bundled as a .exe (PyInstaller), files live next to the executable, not
# in the temporary unpack folder.
if getattr(sys, "frozen", False):
    HERE = os.path.dirname(sys.executable)
else:
    HERE = os.path.dirname(os.path.abspath(__file__))

DEFAULT_SERVER = "https://print.mystay.live"

# A browser-like User-Agent so Cloudflare (Bot Fight Mode) doesn't block the
# agent's requests as "bot traffic". Without this, requests through a Cloudflare
# tunnel can return HTTP 403.
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) QRPrintAgent/1.0"


def load_config():
    path = os.path.join(HERE, "config.json")
    if not os.path.exists(path):
        cfg = first_run_setup(path)
    else:
        with open(path) as f:
            cfg = json.load(f)
    cfg.setdefault("server_url", DEFAULT_SERVER)
    cfg.setdefault("poll_seconds", 3)
    cfg.setdefault("print_mode", "live")
    cfg["server_url"] = cfg["server_url"].rstrip("/")
    return cfg


def first_run_setup(path):
    """Ask the shopkeeper for their agent key the first time, then save it."""
    print("=" * 50)
    print("  QRPrint Agent - first-time setup")
    print("=" * 50)
    print("Your provider gave you an AGENT KEY when they created your shop.")
    key = ""
    while not key:
        key = input("Paste your AGENT KEY here and press Enter: ").strip()
    server = input(f"Server URL [{DEFAULT_SERVER}]: ").strip() or DEFAULT_SERVER
    cfg = {
        "server_url": server,
        "agent_key": key,
        "print_mode": "live",
        "printer_name": None,
        "paper_size": "A4",
        "sumatra_path": "SumatraPDF.exe",
        "poll_seconds": 3,
    }
    with open(path, "w") as f:
        json.dump(cfg, f, indent=2)
    print("\nSaved. (You can re-run this anytime; it remembers your key.)\n")
    return cfg


def api(cfg, method, path, data=None, raw=False):
    url = cfg["server_url"] + path
    headers = {"x-agent-key": cfg["agent_key"], "User-Agent": USER_AGENT}
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        content = resp.read()
        return content if raw else json.loads(content or b"{}")


def download(cfg, path, dest):
    req = urllib.request.Request(
        cfg["server_url"] + path,
        headers={"x-agent-key": cfg["agent_key"], "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=60) as resp, open(dest, "wb") as f:
        shutil.copyfileobj(resp, f)


def process_job(cfg, job):
    print(f"-> job {job['id']}: {job['originalName']} ({job['pages']}p) {job['options']}")
    workdir = os.path.join(HERE, ".work", job["id"])
    os.makedirs(workdir, exist_ok=True)
    src = os.path.join(workdir, "source.pdf")

    try:
        download(cfg, job["fileUrl"], src)
    except Exception as e:
        report(cfg, job["id"], "failed", "print_error", f"download failed: {e}")
        return

    try:
        parts, _ = prepare(src, job["options"], workdir)
        for part in parts:
            print_part(part, job["options"], cfg)
    except PrintError as e:
        print(f"   ! print error ({e.reason}): {e}")
        report(cfg, job["id"], "failed", e.reason, str(e))
        return
    except Exception as e:
        print(f"   ! unexpected error: {e}")
        report(cfg, job["id"], "failed", "print_error", str(e))
        return
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    report(cfg, job["id"], "printed")
    print(f"   done.")


def report(cfg, job_id, result, reason=None, detail=None):
    try:
        api(cfg, "POST", f"/api/agent/jobs/{job_id}/report",
            {"result": result, "reason": reason, "detail": detail})
    except Exception as e:
        print(f"   ! could not report result: {e}")


def heartbeat(cfg):
    try:
        api(cfg, "POST", "/api/agent/heartbeat", {"printer": {"online": True}})
    except Exception:
        pass


def main():
    cfg = load_config()
    if not cfg.get("agent_key"):
        sys.exit("agent_key missing in config.json")
    print(f"QRPrint agent -> {cfg['server_url']}  (print_mode={cfg['print_mode']})")
    print("Waiting for paid jobs. Ctrl+C to stop.\n")

    last_beat = 0
    backoff = 0          # grows when the server is unreachable, resets on success
    max_backoff = 60
    while True:
        try:
            now = time.time()
            if now - last_beat > 30:
                heartbeat(cfg)
                last_beat = now

            resp = api(cfg, "GET", "/api/agent/jobs/next")
            backoff = 0  # reachable again
            job = resp.get("job")
            if job:
                process_job(cfg, job)
                continue  # grab the next one immediately
        except urllib.error.HTTPError as e:
            if e.code == 401:
                print("   ! server rejected the agent key (401). Check agent_key in config.json.")
                time.sleep(15)
            else:
                print(f"   (server error {e.code}) — retrying")
        except urllib.error.URLError as e:
            backoff = min(max_backoff, (backoff or cfg["poll_seconds"]) * 2)
            print(f"   (server unreachable: {e.reason}) — retrying in {backoff}s")
            time.sleep(backoff)
            continue
        except KeyboardInterrupt:
            print("\nStopped.")
            return
        except Exception as e:
            print(f"   (error: {e})")
        time.sleep(cfg["poll_seconds"])


if __name__ == "__main__":
    main()
