"""Run a command in a real PTY and follow scripted steps, without a browser or API key.

STEPS is JSON: [["wait", text], ["send", text], ["sleep", seconds], ...]. A wait looks for text in
everything drawn since the previous send, with ANSI sequences removed. Exits with the command's status; a wait that
times out exits 90 and prints the screen text it saw.
"""
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-B]|\x1b[=>]")
cols, rows = int(os.environ.get("COLS", "100")), int(os.environ.get("ROWS", "24"))
steps = json.loads(os.environ["STEPS"])

pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.execvp("sh", ["sh", "-c", os.environ["COMMAND"]])

seen = b""


def pump(timeout):
    global seen
    if select.select([fd], [], [], timeout)[0]:
        try:
            seen += os.read(fd, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            return False
    return True


try:
    for kind, text in steps:
        if kind == "sleep":
            deadline = time.monotonic() + float(text)
            while time.monotonic() < deadline:
                pump(0.02)
            continue
        if kind == "send":
            seen = b""
            os.write(fd, text.encode())
            continue
        deadline = time.monotonic() + 15
        while text.encode() not in ANSI.sub(b"", seen):
            if time.monotonic() > deadline:
                sys.stderr.write(ANSI.sub(b"", seen).decode(errors="replace"))
                sys.exit(90)
            if not pump(0.05):
                break
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended:
            sys.exit(os.waitstatus_to_exitcode(status))
        pump(0.02)
    sys.exit(91)
finally:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.close(fd)
