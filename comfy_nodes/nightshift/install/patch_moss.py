"""Adapt the pinned Apache MOSS node to Comfy-Org's fused-QKV checkpoints.

The official repack has proj.qkv; the standalone node expects proj.q/k/v.
Missing projections are None in both DynamicVRAM and static mode. Detect the
checkpoint layout and construct its matching projections without changing weights.
The activation dtype also avoids reading packed quantized weight storage.
MPS has no float64, so on a Mac the timestep sinusoid is computed on the CPU.
"""

import argparse
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("node_directory")
args = parser.parse_args()
path = Path(args.node_directory) / "model.py"
source = path.read_text()
marker = "# Nightshift: lazy projection weights may be absent until forward."
if marker in source:
    print("MOSS lazy weight fix already applied")
else:
    target = '        dtype = self.proj["q"].weight.dtype\n'
    if source.count(target) != 1:
        raise RuntimeError("Pinned MOSS block changed. Inspect before patching.")
    path.write_text(source.replace(target, f"        {marker}\n        dtype = x.dtype\n"))
    print("Applied MOSS lazy projection dtype fix")

source = path.read_text()
fused_marker = "# Nightshift: support Comfy-Org fused QKV without rewriting weights."
loader_path = Path(args.node_directory) / "loaders.py"
loader = loader_path.read_text()
if fused_marker in source:
    print("MOSS fused projection fix already applied")
else:
    replacements = {
        'class _Block(nn.Module):\n    def __init__(self, dim, ffn_dim, heads, device, dtype, operations):':
            'class _Block(nn.Module):\n    def __init__(self, dim, ffn_dim, heads, device, dtype, operations, fused_qkv=False):',
        'name: operations.Linear(dim, dim, bias=False, device=device, dtype=dtype)\n                for name in ("q", "k", "v", "o")':
            'name: operations.Linear(dim, 3 * dim if name == "qkv" else dim, bias=False, device=device, dtype=dtype)\n                for name in (("qkv", "o") if fused_qkv else ("q", "k", "v", "o"))',
        '        q = self.q_norm(self.proj["q"](y).unflatten(-1, (self.heads, -1))).flatten(2)\n        k = self.k_norm(self.proj["k"](y).unflatten(-1, (self.heads, -1))).flatten(2)\n        x = x + self.proj["o"](_attention(q, k, self.proj["v"](y), rope, self.heads)) * gate_a[:, None]':
            f'        {fused_marker}\n'
            '        if "qkv" in self.proj:\n'
            '            q, k, v = self.proj["qkv"](y).chunk(3, -1)\n'
            '        else:\n'
            '            q, k, v = (self.proj[name](y) for name in ("q", "k", "v"))\n'
            '        q = self.q_norm(q.unflatten(-1, (self.heads, -1))).flatten(2)\n'
            '        k = self.k_norm(k.unflatten(-1, (self.heads, -1))).flatten(2)\n'
            '        x = x + self.proj["o"](_attention(q, k, v, rope, self.heads)) * gate_a[:, None]',
        '        operations=None,\n        **kwargs,':
            '        operations=None,\n        fused_qkv=False,\n        **kwargs,',
        '_Block(dim, ffn_dim, num_heads, device, dtype, operations) for _ in range(num_layers)':
            '_Block(dim, ffn_dim, num_heads, device, dtype, operations, fused_qkv) for _ in range(num_layers)',
    }
    for old in replacements:
        if source.count(old) != 1:
            raise RuntimeError("Pinned MOSS model changed. Inspect before applying fused QKV fix.")
    target = '            "rope_base": 10000.0,\n'
    if loader.count(target) != 1:
        raise RuntimeError("Pinned MOSS configuration changed. Inspect before patching.")
    for old, replacement in replacements.items():
        source = source.replace(old, replacement)
    loader = loader.replace(target, target + '            "fused_qkv": "layers.0.proj.qkv.weight" in state,\n')
    compile(source, str(path), "exec")
    compile(loader, str(loader_path), "exec")
    path.write_text(source)
    loader_path.write_text(loader)
    print("Applied MOSS fused projection layout fix")

source = path.read_text()
mps_marker = "# Nightshift: MPS has no float64; compute the sinusoid on the CPU there."
if mps_marker in source:
    print("MOSS float64 timestep fix already applied")
else:
    target = (
        '        freq = 10000 ** (-torch.arange(half, device=times.device, dtype=torch.float64) / half)\n'
        '        phase = times.double()[:, None] * freq\n'
        '        embedding = torch.cat((phase.cos(), phase.sin()), -1).float()\n'
    )
    if source.count(target) != 1:
        raise RuntimeError("Pinned MOSS timestep embedding changed. Inspect before patching.")
    replacement = (
        f'        {mps_marker}\n'
        '        where = torch.device("cpu") if times.device.type == "mps" else times.device\n'
        '        freq = 10000 ** (-torch.arange(half, device=where, dtype=torch.float64) / half)\n'
        '        phase = times.to(where).double()[:, None] * freq\n'
        '        embedding = torch.cat((phase.cos(), phase.sin()), -1).float().to(times.device)\n'
    )
    source = source.replace(target, replacement)
    compile(source, str(path), "exec")
    path.write_text(source)
    print("Applied MOSS float64 timestep fix")
