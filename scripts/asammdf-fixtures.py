"""Writes MDF files with asammdf (a writer other than SigMixa) for SigMixa's MDF tests to read.

Usage (asammdf installed, for example in a virtual environment under work/):
    python scripts/asammdf-fixtures.py tests/fixtures/mdf
    python scripts/asammdf-reference.py tests/fixtures/mdf tests/fixtures/mdf/reference.json

The files hold measured signals of many kinds: integer and float types, linear, rational, formula and table
conversions, value texts, structures, several groups and rates, compressed and transposed data blocks,
MDF 4.00 / 4.10 / 4.20 and MDF 3.30. The values come from fixed formulas, so the files are the same each time.
"""
import os
import sys

import numpy as np
from asammdf import MDF, Signal


def signals(count, rate, offset=0.0):
    t = offset + np.arange(count, dtype=np.float64) / rate
    i = np.arange(count)
    return [
        Signal((np.sin(i / 7.0) * 100).astype(np.float64), t, name="Wave", unit="m/s"),
        Signal((i % 256).astype(np.uint8), t, name="Counter8", unit=""),
        Signal(((i * 37) % 65536 - 32768).astype(np.int16), t, name="Signed16"),
        Signal((i * 1000003 % 4294967296).astype(np.uint32), t, name="Unsigned32"),
        Signal((i * 3).astype(np.int64), t, name="Big64"),
        Signal((np.cos(i / 5.0) * 10).astype(np.float32), t, name="Float32", unit="V"),
        Signal((i % 1000).astype(np.uint16), t, name="Linear", unit="km/h", conversion={"a": 0.1, "b": -20.0}),
        Signal((i % 500).astype(np.uint16), t, name="Rational", conversion={"P1": 0, "P2": 2, "P3": 1, "P4": 0, "P5": 0, "P6": 4}),
        Signal((i % 300).astype(np.uint16), t, name="Formula", conversion={"formula": "X * 0.5 + 3"}),
        Signal((i % 4).astype(np.uint8), t, name="Gear", conversion={"val_0": 0, "text_0": b"Park", "val_1": 1, "text_1": b"Reverse", "val_2": 2, "text_2": b"Neutral", "val_3": 3, "text_3": b"Drive", "default": b"?"}),
        Signal((i % 10).astype(np.uint8), t, name="Table", conversion={"raw_0": 0, "phys_0": 0.0, "raw_1": 9, "phys_1": 90.0}),
        Signal((i % 2).astype(np.uint8), t, name="Flag", bit_count=1),
    ]


def structured(count, rate):
    t = np.arange(count, dtype=np.float64) / rate
    i = np.arange(count)
    point = np.zeros(count, dtype=[("X", "<f8"), ("Y", "<f8"), ("Z", "<i2")])
    point["X"] = np.sin(i / 9.0); point["Y"] = np.cos(i / 9.0); point["Z"] = i % 100
    # Arrays are left to the files SigMixa makes: asammdf 8 keeps only one value of an array signal it is given.
    return [Signal(point, t, name="Position"), Signal((i % 50).astype(np.float32), t, name="Speed", unit="rpm")]


def write(path, version, groups, compression=0):
    with MDF(version=version) as mdf:
        for items in groups:
            mdf.append(items, comment="SigMixa fixture", common_timebase=True)
        mdf.save(path, overwrite=True, compression=compression)


def main():
    folder = sys.argv[1]
    os.makedirs(folder, exist_ok=True)
    groups = [signals(1000, 100.0), signals(250, 10.0, 0.05)]
    write(os.path.join(folder, "asammdf-signals-410.mf4"), "4.10", groups)
    write(os.path.join(folder, "asammdf-signals-400.mf4"), "4.00", groups)
    write(os.path.join(folder, "asammdf-signals-420.mf4"), "4.20", groups)
    write(os.path.join(folder, "asammdf-deflate.mf4"), "4.10", [signals(8000, 1000.0)], compression=1)
    write(os.path.join(folder, "asammdf-transposed.mf4"), "4.10", [signals(8000, 1000.0)], compression=2)
    write(os.path.join(folder, "asammdf-structures.mf4"), "4.10", [structured(500, 50.0)])
    write(os.path.join(folder, "asammdf-structures-transposed.mf4"), "4.10", [structured(8000, 500.0)], compression=2)
    mdf3 = [[item for item in signals(800, 50.0) if item.name not in ("Big64", "Rational", "Formula")]]
    write(os.path.join(folder, "asammdf-signals-330.mdf"), "3.30", mdf3)


if __name__ == "__main__":
    main()
