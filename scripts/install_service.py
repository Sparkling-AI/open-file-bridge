#!/usr/bin/env python3
"""
File Bridge — service installer (P2 rollout item).

Installs a per-user background service so the bridge starts at login:
  Linux:   systemd user unit  (~/.config/systemd/user/file-bridge.service)
  macOS:   LaunchAgent plist  (~/Library/LaunchAgents/com.filebridge.bridge.plist),
           loaded via launchctl (RunAtLoad + KeepAlive)
  Windows: writes a .bat + Startup shortcut instructions (real service
           registration — NSSM/Task Scheduler — is the user's final phase).

Usage:
  python scripts/install_service.py            # install + start now
  python scripts/install_service.py --status   # show unit + service state
  python scripts/install_service.py --remove   # stop + uninstall
  python scripts/install_service.py --exec dist/FileBridge --arg ~/my-folder

The service runs the bridge from its repo/source location with the CURRENT
python. For the frozen binary, pass --exec /path/to/FileBridge (plus --arg
<folder> to pre-select the shared folder).
Idempotent: reinstall overwrites the unit file cleanly.
"""
import argparse
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
UNIT_NAME = "file-bridge.service"
PLIST_NAME = "com.filebridge.bridge.plist"


def bridge_cmd(exec_path: str | None) -> list:
    if exec_path:
        return [exec_path]
    return [sys.executable, str(REPO / "src" / "file_bridge.py")]


# --------------------------------------------------------------- Linux

def linux_unit_path() -> Path:
    base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "systemd" / "user" / UNIT_NAME


def linux_install(cmd: list) -> bool:
    unit = linux_unit_path()
    unit.parent.mkdir(parents=True, exist_ok=True)
    state = Path(os.environ.get("FILE_BRIDGE_STATE_DIR")
                 or Path.home() / ".local" / "state" / "file-bridge")
    state.mkdir(parents=True, exist_ok=True)
    unit.write_text(f"""[Unit]
Description=File Bridge (local file access for Open WebUI)
After=network.target

[Service]
Type=simple
ExecStart={' '.join(cmd)}
Restart=on-failure
RestartSec=3
Environment=FILE_BRIDGE_NO_LOGFILE=1
Environment=FILE_BRIDGE_NO_UI=1

[Install]
WantedBy=default.target
""")
    print(f"unit written: {unit}")
    for args in (["systemctl", "--user", "daemon-reload"],
                 ["systemctl", "--user", "enable", "--now", UNIT_NAME]):
        r = subprocess.run(args, capture_output=True, text=True)
        if r.returncode != 0:
            print(f"FAILED: {' '.join(args)}\n{r.stderr.strip()}")
            return False
        print(f"ok: {' '.join(args)}")
    return True


def linux_status() -> bool:
    r = subprocess.run(["systemctl", "--user", "is-active", UNIT_NAME],
                       capture_output=True, text=True)
    print(f"unit: {linux_unit_path()}")
    print(f"active: {r.stdout.strip() or r.stderr.strip()}")
    return r.returncode == 0


def linux_remove() -> bool:
    subprocess.run(["systemctl", "--user", "disable", "--now", UNIT_NAME],
                   capture_output=True, text=True)
    subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)
    unit = linux_unit_path()
    if unit.exists():
        unit.unlink()
        print(f"removed: {unit}")
    return True


# ---------------------------------------------------------------- macOS

def mac_plist_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / PLIST_NAME


def _launchctl(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["launchctl", *args], capture_output=True, text=True)


def mac_install(cmd: list) -> bool:
    plist = mac_plist_path()
    plist.parent.mkdir(parents=True, exist_ok=True)
    escaped = "".join(
        f"<string>{c}</string>" for c in cmd)
    plist.write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.filebridge.bridge</string>
  <key>ProgramArguments</key>
  <array>{escaped}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
    <key>EnvironmentVariables</key>
  <dict>
    <key>FILE_BRIDGE_NO_LOGFILE</key><string>1</string>
    <key>FILE_BRIDGE_NO_UI</key><string>1</string>
  </dict>
  <key>StandardErrorPath</key>
  <string>{Path.home()}/Library/Logs/file-bridge.log</string>
  <key>StandardOutPath</key>
  <string>{Path.home()}/Library/Logs/file-bridge.log</string>
</dict>
</plist>
""")
    print(f"plist written: {plist}")
    # replace any previously loaded instance, then load the new one
    _launchctl("bootout", f"gui/{os.getuid()}/com.filebridge.bridge")
    r = _launchctl("bootstrap", f"gui/{os.getuid()}", str(plist))
    if r.returncode != 0:
        print(f"FAILED: launchctl bootstrap\n{r.stderr.strip()}")
        return False
    print("ok: launchctl bootstrap (RunAtLoad + KeepAlive)")
    return True


def mac_status() -> bool:
    p = mac_plist_path()
    print(f"plist: {p} ({'exists' if p.exists() else 'missing'})")
    r = _launchctl("print", f"gui/{os.getuid()}/com.filebridge.bridge")
    loaded = r.returncode == 0
    print(f"loaded: {loaded}")
    if loaded:
        for line in r.stdout.splitlines():
            if "pid" in line.lower() or "state" in line.lower():
                print(f"  {line.strip()}")
                break
    return p.exists() and loaded


def mac_remove() -> bool:
    r = _launchctl("bootout", f"gui/{os.getuid()}/com.filebridge.bridge")
    if r.returncode != 0 and "No such process" not in (r.stderr or ""):
        print(f"note: bootout: {(r.stderr or '').strip()}")
    p = mac_plist_path()
    if p.exists():
        p.unlink()
        print(f"removed: {p}")
    return True


# -------------------------------------------------------------- Windows

def win_install(cmd: list) -> bool:
    # write-only (user's final phase does real testing): Startup folder .bat
    startup = (Path(os.environ["APPDATA"]) / "Microsoft" / "Windows"
               / "Start Menu" / "Programs" / "Startup")
    bat = startup / "file-bridge.bat"
    bat.parent.mkdir(parents=True, exist_ok=True)
    joined = " ".join(f'"{c}"' for c in cmd)
    bat.write_text(f"@echo off\r\nset \"FILE_BRIDGE_NO_UI=1\"\r\n{joined}\r\n",
                   encoding="ascii")
    print(f"startup script written: {bat} (Windows untested — user's final phase)")
    return True


def win_status() -> bool:
    startup = (Path(os.environ["APPDATA"]) / "Microsoft" / "Windows"
               / "Start Menu" / "Programs" / "Startup")
    bat = startup / "file-bridge.bat"
    print(f"startup script: {bat} ({'exists' if bat.exists() else 'missing'})")
    return bat.exists()


def win_remove() -> bool:
    startup = (Path(os.environ["APPDATA"]) / "Microsoft" / "Windows"
               / "Start Menu" / "Programs" / "Startup")
    bat = startup / "file-bridge.bat"
    if bat.exists():
        bat.unlink()
        print(f"removed: {bat}")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--remove", action="store_true")
    ap.add_argument("--exec", help="frozen binary path (default: repo python)")
    ap.add_argument("--arg", action="append", default=[],
                    help="extra argument appended to the service command "
                         "(repeatable, e.g. --arg /path/to/shared/folder)")
    args = ap.parse_args()

    system = platform.system()
    impl = {"Linux": (linux_install, linux_status, linux_remove),
            "Darwin": (mac_install, mac_status, mac_remove),
            "Windows": (win_install, win_status, win_remove)}[system]
    install, status, remove = impl

    if args.remove:
        ok = remove()
    elif args.status:
        ok = status()
    else:
        cmd = bridge_cmd(args.exec) + args.arg
        print(f"service command: {' '.join(cmd)}")
        ok = install(cmd)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
