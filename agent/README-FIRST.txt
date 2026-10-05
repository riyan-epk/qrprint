QRPrint Agent for Windows  -  version {VERSION}
=================================================
This program connects your printer to QRPrint. Customers scan your QR code,
send their documents, and they print here automatically. No installation needed.

WHAT'S IN THIS FOLDER
  qrprint-agent.exe   the QRPrint Agent (double-click to run)
  SumatraPDF.exe      the free PDF printer it uses (keep it in the same folder)
  README-FIRST.txt    this guide

SETUP (one time, about 2 minutes)
  1. Copy this whole folder to the shop computer, e.g.  C:\QRPrint
     (not inside Downloads, and not on a USB stick).
  2. Turn the printer ON and make it the DEFAULT printer:
     Settings > Bluetooth & devices > Printers & scanners > your printer > Set as default.
  3. Double-click  qrprint-agent.exe
     If Windows shows "Windows protected your PC", click  More info > Run anyway.
  4. Paste the AGENT KEY your provider gave you and press Enter.
     It checks the key and shows your shop's name.
  5. When asked "Start automatically when this PC turns on?", press Enter (Yes).
  6. The window now says "Waiting for paid jobs". That's it - your printer is live.
     You can minimise the window, but do not close it.

CHECK THAT IT WORKS
  - Print a test page: open a Command Prompt in this folder and run
        qrprint-agent.exe --test
  - Or scan your shop's QR code with a phone, send a PDF and pay.
    It prints here and appears in your dashboard.

WHAT THE WINDOW TELLS YOU
  "Waiting for paid jobs"        all good
  "-> Printing: ... done."       a customer's job printed
  "Printer problem: no paper"    fix the printer; waiting jobs print by
                                 themselves once it's ready again
  "server unreachable"           check the internet; it keeps retrying
  "rejected the agent key"       your key changed - run  qrprint-agent.exe --setup
  "linked to another computer"   see "Moving to a new computer" below

GOOD TO KNOW
  - Only one copy runs at a time. If you start it twice, the second one closes.
  - It only prints jobs that are already paid (or approved by you for cash).
  - Customers' files are deleted from this computer straight after printing.
  - ID card copies and passport photos print at their real size.
  - A log of everything it did is kept in  agent.log  in this folder.

MOVING TO A NEW COMPUTER
  For security, your agent key works on ONE computer. To move:
  1. Ask your provider to "Unlink PC" for your shop.
  2. Copy this folder to the new computer and run qrprint-agent.exe.

USEFUL COMMANDS (run in a Command Prompt in this folder)
  qrprint-agent.exe --setup            enter a new agent key
  qrprint-agent.exe --autostart off    stop starting with Windows
  qrprint-agent.exe --autostart on     start with Windows again
  qrprint-agent.exe --test             print a test page
  qrprint-agent.exe --version          show the version

ADVANCED (config.json, next to the program)
  "printer_name": null                 null = default printer, or the exact printer name
  "print_mode": "live"                 "dry" = test mode, nothing is printed
  "pause_on_printer_problem": true     set to false if your printer wrongly shows as offline

IF A PRINT FAILS
  - Paper out or jam: fix it, then press "Reprint" on that job in your dashboard.
  - A print that truly can't happen can be refunded from your dashboard.

Need help?  Email {EMAIL}  or WhatsApp {WHATSAPP}
