# Runs the Acestream Android engine (arm64) for AceSwarm. start-arm64.sh runs this file instead of
# the engine's own main.py, which then runs unchanged from its folder.
#
# The engine asks its Android bridge (app_bridge.py, in the engine's folder) for the free space of
# its cache folder through getAvailableBlocks, getBlockSize and getBlockCount, which the image's
# bridge does not answer. This file answers those three calls from the file system, and passes
# every other call on to the bridge.
#
# The engine also keeps its settings in a pickle in its state folder, and it picks the cache type
# itself when those settings do not name one (memory, on Android). The option --live-cache-type disk
# does not change that pick, so when the options ask for disk, this file saves the disk settings
# before the engine starts (save_disk_settings).
#
# Nothing of the engine or of its wrapper is copied into this file: it only changes what they call.

import os
import pickle
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


ENGINE_HOME = '/dev/shm'  # the bridge answers getAceStreamHome with this folder
STATE_FILE = os.path.join(ENGINE_HOME, '.ACEStream', 'playerconf.pickle')


def option_value(argv, name):
    # The value of the last occurrence of an option, or None.
    value = None
    for i, arg in enumerate(argv[:-1]):
        if arg == name:
            value = argv[i + 1]
    return value


def save_disk_settings(argv, state_file=STATE_FILE):
    # Saves the cache type and the disk limit the options ask for, so the engine finds them saved.
    # Returns the saved settings, or None when the options do not ask for disk.
    if option_value(argv, '--live-cache-type') != 'disk':
        return None
    limit = option_value(argv, '--disk-cache-limit')
    if limit is None or not limit.isdigit():
        raise ValueError('--disk-cache-limit must be a number of bytes, got %r' % (limit,))
    settings = {}
    if os.path.isfile(state_file):
        try:
            with open(state_file, 'rb') as f:
                loaded = pickle.load(f, encoding='replace')
            if isinstance(loaded, dict):
                settings = loaded
        except Exception:
            settings = {}  # a file the engine cannot read is replaced
    settings['live_cache_type'] = 'disk'
    settings['disk_cache_limit'] = int(limit)
    settings['disk_cache_auto'] = False
    os.makedirs(os.path.dirname(state_file), exist_ok=True)
    tmp = state_file + '.shim'
    with open(tmp, 'wb') as f:
        pickle.dump(settings, f, protocol=2)
    os.replace(tmp, state_file)
    sys.stderr.write('arm64-shim: saved live_cache_type=disk and disk_cache_limit=%s for the engine start\n' % limit)
    return settings


def main():
    # Imports and file names resolve as when the engine runs from its own folder.
    sys.path[0] = ENGINE_DIR
    install_disk_calls()
    # Before the engine starts: a failure stops the start, so the run does not quietly use memory.
    save_disk_settings(sys.argv[1:])
    sys.argv = [ENGINE_MAIN] + sys.argv[1:]
    runpy.run_path(ENGINE_MAIN, run_name='__main__')


if __name__ == '__main__':
    main()
