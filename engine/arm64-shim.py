# Runs the Acestream Android engine (arm64) for AceSwarm. start-arm64.sh runs this file instead of
# the engine's own main.py, which then runs unchanged from its folder.
#
# The engine asks its Android bridge (app_bridge.py, in the engine's folder) for the free space of
# its cache folder through getAvailableBlocks, getBlockSize and getBlockCount, which the image's
# bridge does not answer. This file answers those three calls from the file system, and passes
# every other call on to the bridge.
#
# Nothing of the engine or of its wrapper is copied into this file: it only changes what they call.

import os
import runpy
import sys

ENGINE_DIR = '/acestream'
ENGINE_MAIN = os.path.join(ENGINE_DIR, 'main.py')

# The calls answered here. The engine names the folder it asks about as the first argument.
DISK_CALLS = ('getAvailableBlocks', 'getBlockSize', 'getBlockCount')

_announced = False


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


def main():
    # Imports and file names resolve as when the engine runs from its own folder.
    sys.path[0] = ENGINE_DIR
    install_disk_calls()
    sys.argv = [ENGINE_MAIN] + sys.argv[1:]
    runpy.run_path(ENGINE_MAIN, run_name='__main__')


if __name__ == '__main__':
    main()
