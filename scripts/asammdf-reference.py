"""Writes what asammdf reads from MDF files, as the reference SigMixa's MDF tests compare with.

Usage (asammdf installed, for example in a virtual environment under work/):
    python scripts/asammdf-reference.py tests/fixtures/mdf tests/fixtures/mdf/reference.json

For every .mf4 and .mdf file in the folder: each channel of each channel group with its sample count, unit, whether it is the group's time
(master), and up to nine samples (index, time, value; byte arrays as lists of bytes, other values that are not numbers as null). A file
asammdf cannot read is listed with its error.
"""
import json
import math
import os
import sys

import numpy as np
from asammdf import MDF


def picks(count):
    if count <= 0:
        return []
    return sorted({round(i * (count - 1) / 8) for i in range(9)})


def value(sample):
    if isinstance(sample, (bytes, bytearray)):
        return None
    if isinstance(sample, np.ndarray):
        if sample.dtype == np.uint8 and sample.ndim == 1:
            return [int(byte) for byte in sample]
        return None
    if isinstance(sample, np.void):
        return None
    try:
        number = float(sample)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def read(path):
    groups = []
    with MDF(path) as mdf:
        for group_index, group in enumerate(mdf.groups):
            channels = []
            for channel_index, channel in enumerate(group.channels):
                try:
                    signal = mdf.get(group=group_index, index=channel_index)
                except Exception as error:  # a channel asammdf cannot give
                    channels.append({"name": channel.name, "error": str(error)})
                    continue
                samples = signal.samples
                count = len(samples)
                points = []
                for index in picks(count):
                    points.append([index, float(signal.timestamps[index]), value(samples[index])])
                entry = {"name": channel.name, "count": count, "unit": signal.unit or "", "points": points}
                # The time channel of the group (master or virtual master), which is no signal of its own.
                if channel.channel_type in ((1,) if mdf.version < "4.00" else (2, 3)):
                    entry["master"] = True
                channels.append(entry)
            groups.append({"group": group_index, "channels": channels})
    return groups


def main():
    folder, output = sys.argv[1], sys.argv[2]
    entries = []
    for name in sorted(os.listdir(folder)):
        if not name.lower().endswith((".mf4", ".mdf")):
            continue
        entry = {"file": name}
        try:
            entry["groups"] = read(os.path.join(folder, name))
        except Exception as error:
            entry["error"] = str(error)
        entries.append(entry)
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(entries, handle, indent=1)
        handle.write("\n")


if __name__ == "__main__":
    main()
