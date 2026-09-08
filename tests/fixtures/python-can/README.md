# python-can BLF test fixtures

These files were copied from the `test/data` directory of python-can commit
`b4f82abede25ff83376be793a2935c41f81c3869`:

https://github.com/hardbyte/python-can

Included fixtures:

- `test_CanMessage.blf`
- `test_CanMessage2.blf`
- `test_CanFdMessage.blf`
- `test_CanFdMessage64.blf`
- `issue_1905.blf`

They are used only for parser compatibility tests and are excluded from the
published VSIX by `.vscodeignore`. python-can is distributed under LGPL-3.0;
the accompanying `LICENSE.txt` is an unmodified copy from that repository.

The python-can tests identify the first four files as originating from the
Vector BLF test suite created by Tobias Lorenz.
