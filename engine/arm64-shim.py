# Runs the Acestream Android engine (arm64) for AceSwarm. start-arm64.sh runs this file instead of
# the engine's own main.py, which then runs unchanged from its folder.
#
# The engine asks its Android bridge (app_bridge.py, in the engine's folder) for the free space of
# the cache folder, through getAvailableBlocks, getBlockSize and getBlockCount. The image's bridge
# does not answer those calls, so the engine's disk cache cannot be used there. This file answers
# them from the file system itself, and passes every other call on to the bridge.
#
# Nothing of the engine or of its wrapper is copied into this file: it only changes what they call.

import os
import runpy
import sys

ENGINE_DIR = '/acestream'
ENGINE_MAIN = os.path.join(ENGINE_DIR, 'main.py')

# Calls answered from the file system, with the free and total space of the folder they name.
DISK_CALLS = ('getAvailableBlocks', 'getBlockSize', 'getBlockCount', 'getAvailableBytes',
              'getFreeBytes', 'getTotalBytes')


def existing_folder(path):
    # The engine may name a folder it has not made yet: ask about the closest one that exists.
    path = os.path.abspath(path or '/')
    while not os.path.isdir(path):
        parent = os.path.dirname(path)
        if parent == path:
            return '/'
        path = parent
    return path


def disk_call(method, args):
    folder = args[0] if args and isinstance(args[0], str) else '/'
    st = os.statvfs(existing_folder(folder))
    if method == 'getAvailableBlocks':
        return st.f_bavail
    if method == 'getBlockSize':
        return st.f_frsize
    if method == 'getBlockCount':
        return st.f_blocks
    if method in ('getAvailableBytes', 'getFreeBytes'):
        return st.f_bavail * st.f_frsize
    return st.f_blocks * st.f_frsize  # getTotalBytes


def install_disk_calls():
    # The bridge module the engine imports (its folder is first on sys.path, see main below).
    import app_bridge
    bridge = app_bridge.Android
    fake_rpc = bridge._fake_rpc

    def _fake_rpc(self, method, *args):
        if method in DISK_CALLS:
            return disk_call(method, args)
        return fake_rpc(self, method, *args)

    bridge._fake_rpc = _fake_rpc


def main():
    # Imports and file names resolve as when the engine runs from its own folder.
    sys.path[0] = ENGINE_DIR
    install_disk_calls()
    sys.argv = [ENGINE_MAIN] + sys.argv[1:]
    runpy.run_path(ENGINE_MAIN, run_name='__main__')


if __name__ == '__main__':
    main()
