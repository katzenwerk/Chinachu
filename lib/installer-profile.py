#!/usr/bin/env python3
"""Optional per-stage measurement; command status is independent of metric output."""
import json, os, resource, subprocess, sys, time, shutil
label, *command = sys.argv[1:]
io_priority = None
try:
    if shutil.which('ionice'):
        io_priority = subprocess.check_output(['ionice', '-p', str(os.getpid())], text=True, stderr=subprocess.DEVNULL).strip()
except (OSError, subprocess.SubprocessError):
    pass
started = time.monotonic()
try:
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    priority = os.getpriority(os.PRIO_PROCESS, 0)
except (OSError, AttributeError):
    before = None
    priority = None
try:
    status = subprocess.call(command)
except OSError as error:
    print(str(error), file=sys.stderr)
    sys.exit(127)
try:
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    print('[installer-profile] ' + json.dumps({
        'stage': label, 'seconds': round(time.monotonic()-started, 3), 'nice': priority, 'ioPriority': io_priority,
        'cpuSeconds': round(after.ru_utime + after.ru_stime - (before.ru_utime + before.ru_stime if before else 0), 3),
        'peakRssKiB': after.ru_maxrss, 'inputBlocks': after.ru_inblock, 'outputBlocks': after.ru_oublock,
        'status': status}, separators=(',', ':')), file=sys.stderr)
except Exception:
    pass
sys.exit(status if status >= 0 else 128-status)
