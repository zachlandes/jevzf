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
    os.execvp("sh", ["sh", "-c", '''
exec fzf --disabled --no-sort --query="$SEARCH_QUERY" \
  --bind='ctrl-r:reload-sync(jevzf -- {q} < "$JEVZF_INPUT" || true)' \
  --bind='load:execute-silent(touch "$READY")' \
  < "$JEVZF_INPUT" > "$RESULT"
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
    os.write(fd, b"\x12")
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
