"""Exercise the documented binding in a real PTY, without a browser or API key."""
import errno
import fcntl
import struct
import termios
import os
import pty
import select
import signal
import sys
import time

pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
    # The README's recipe, plus a load hook so the driver knows when each list is in
    os.execvp("sh", ["sh", "-c", '''
SRC='cat "$JEVZF_INPUT"'
eval "$SRC" | fzf --query="$SEARCH_QUERY" \
    --bind "ctrl-space:reload($SRC | jevzf --closest 3 -- {q})+disable-search+change-prompt(meaning> )" \
    --bind "ctrl-f:reload($SRC)+enable-search+change-prompt(> )" \
    --bind 'load:execute-silent(touch "$READY")' > "$RESULT"
'''])


def wait_ready():
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if os.path.exists(os.environ["READY"]):
            return
        if select.select([fd], [], [], 0.05)[0]:
            try:
                os.read(fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
    raise RuntimeError("fzf did not finish loading")


try:
    wait_ready()
    os.unlink(os.environ["READY"])
    os.write(fd, b"\x00")
    wait_ready()
    os.write(fd, b"\r")
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended:
            sys.exit(os.waitstatus_to_exitcode(status))
        if select.select([fd], [], [], 0.02)[0]:
            try:
                os.read(fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
    raise RuntimeError("fzf did not exit")
finally:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.close(fd)
