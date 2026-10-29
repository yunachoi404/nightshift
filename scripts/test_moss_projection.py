"""CPU equivalence test against the installed MOSS block, without importing ComfyUI."""

import argparse
import ast
from pathlib import Path

import torch
from torch import nn
from torch.nn import functional as F

parser = argparse.ArgumentParser()
parser.add_argument("node_directory")
args = parser.parse_args()
tree = ast.parse((Path(args.node_directory) / "model.py").read_text())
selected = ast.Module(body=[entry for entry in tree.body if isinstance(entry, (ast.FunctionDef, ast.ClassDef))
                           and entry.name in {"_situ", "_rotate", "_attention", "_Block"}], type_ignores=[])


def cpu_attention(q, k, v, heads, skip_reshape):
    assert skip_reshape
    output = F.scaled_dot_product_attention(q, k, v)
    return output.transpose(1, 2).flatten(2)


namespace = {"torch": torch, "nn": nn, "optimized_attention": cpu_attention}
exec(compile(selected, "installed_moss_block", "exec"), namespace)
torch.manual_seed(42)
block = namespace["_Block"]
separate = block(16, 24, 2, "cpu", torch.float32, nn)
fused = block(16, 24, 2, "cpu", torch.float32, nn, fused_qkv=True)
state = separate.state_dict()
state["proj.qkv.weight"] = torch.cat([state.pop(f"proj.{name}.weight") for name in ("q", "k", "v")])
fused.load_state_dict(state, strict=True)
x = torch.randn(2, 5, 16)
rope = torch.randn(1, 5, 8)
modulation = torch.randn(2, 6, 16)
with torch.no_grad():
    expected = separate(x, rope, modulation)
    actual = fused(x, rope, modulation)
torch.testing.assert_close(actual, expected, atol=1e-5, rtol=1e-5)
print(f"Fused/separate installed MOSS blocks match on CPU; maximum error {float((actual-expected).abs().max()):.3g}")
