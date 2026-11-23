# Runs the Acestream Android engine (arm64) for AceSwarm. start-arm64.sh runs this file instead of
# the engine's own main.py, which then runs unchanged from its folder.
#
# The engine differs from the x86_64 one in two ways that this file works around:
#
# 1. The engine asks its Android bridge (app_bridge.py, in the engine's folder) for the free space of
#    its cache folder through getAvailableBlocks, getBlockSize and getBlockCount, which the image's
#    bridge does not answer. This file answers those three calls from the file system, and passes
#    every other call on to the bridge (install_disk_calls).
#
# 2. The engine picks its stream cache type from the machine's memory when it starts, and the option
#    --live-cache-type disk does not change that pick: on a machine the size of a Raspberry Pi it
#    keeps the stream in memory. When the options ask for disk, this file shows the engine a smaller
#    memory figure from /proc/meminfo while it runs, so that the pick is disk (show_capped_meminfo).
#
# Nothing of the engine or of its wrapper is copied into this file: it only changes what they call.

import builtins
import io
import os
import runpy
import sys

ENGINE_DIR = '/acestream'
ENGINE_MAIN = os.path.join(ENGINE_DIR, 'main.py')

# The calls answered here. The engine names the folder it asks about as the first argument.
DISK_CALLS = ('getAvailableBlocks', 'getBlockSize', 'getBlockCount')

# The memory the engine sees in disk mode, in kB as /proc/meminfo counts them: 512 MB, the value
# that made the engine pick disk in testing. The fields below are capped to it, as they are read.
MEMINFO = '/proc/meminfo'
DISK_MODE_RAM_KB = 512 * 1024
CAPPED_FIELDS = ('MemTotal:', 'MemFree:', 'MemAvailable:')

_announced = False
_real_open = builtins.open


def existing_folder(path):
    # The engine may name a folder it has not made yet: ask about the closest one that exists.
    path = os.path.abspath(path)
    while not os.path.isdir(path):
        parent = os.path.dirname(path)
        if parent == path:
            return '/'
        path = parent
    return path


def disk_folder(method, args):
    if args and isinstance(args[0], str) and args[0]:
        return args[0]
    # Without a folder argument, the cache folder the entrypoint made for this engine.
    folder = os.environ.get('ACESWARM_CACHE_DIR', '')
    if not folder:
        raise ValueError('%s: no folder was given and ACESWARM_CACHE_DIR is not set' % method)
    return folder


def disk_call(method, args):
    global _announced
    folder = disk_folder(method, args)
    st = os.statvfs(existing_folder(folder))
    if not _announced:
        _announced = True
        sys.stderr.write('arm64-shim: answering disk-space calls for %s\n' % folder)
    if method == 'getAvailableBlocks':
        return st.f_bavail
    if method == 'getBlockSize':
        return st.f_frsize
    return st.f_blocks  # getBlockCount


def install_disk_calls():
    # The bridge module the engine imports: its folder is first on sys.path once main() runs.
    import app_bridge
    bridge = app_bridge.Android
    fake_rpc = bridge._fake_rpc

    def _fake_rpc(self, method, *args):
        if method in DISK_CALLS:
            return disk_call(method, args)
        return fake_rpc(self, method, *args)

    bridge._fake_rpc = _fake_rpc


def capped_meminfo(text, limit_kb):
    # The text of /proc/meminfo with its memory fields capped at limit_kb; the other lines are kept.
    lines = []
    for line in text.splitlines(True):
        parts = line.split()
        if len(parts) == 3 and parts[0] in CAPPED_FIELDS and parts[1].isdigit() and parts[2] == 'kB':
            line = '%s %d kB\n' % (parts[0], min(int(parts[1]), limit_kb))
        lines.append(line)
    return ''.join(lines)


def show_capped_meminfo(limit_kb):
    # Every open of /proc/meminfo in this process gives the capped text from now on. Python code reads
    # the memory figures through open() (psutil does), so that is where the engine's pick is answered.
    def open_meminfo(file, mode='r', *args, **kwargs):
        if file != MEMINFO:
            return _real_open(file, mode, *args, **kwargs)
        with _real_open(MEMINFO, 'r') as f:
            text = capped_meminfo(f.read(), limit_kb)
        if 'b' in mode:
            return io.BytesIO(text.encode('ascii'))
        return io.StringIO(text)

    builtins.open = open_meminfo


def option_value(argv, name):
    # The value of the last occurrence of an option, or None.
    value = None
    for i, arg in enumerate(argv[:-1]):
        if arg == name:
            value = argv[i + 1]
    return value


def main():
    # Imports and file names resolve as when the engine runs from its own folder.
    sys.path[0] = ENGINE_DIR
    install_disk_calls()
    argv = sys.argv[1:]
    if option_value(argv, '--live-cache-type') == 'disk':
        # Before the engine starts: the pick of its cache type happens when it starts.
        show_capped_meminfo(DISK_MODE_RAM_KB)
        sys.stderr.write('arm64-shim: showing the engine %d MB of memory for its cache type\n'
                         % (DISK_MODE_RAM_KB // 1024))
    sys.argv = [ENGINE_MAIN] + argv
    runpy.run_path(ENGINE_MAIN, run_name='__main__')


if __name__ == '__main__':
    main()
