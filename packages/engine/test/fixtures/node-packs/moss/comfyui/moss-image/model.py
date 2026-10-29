from torch import nn


def _attention(q, k, v, rope, heads):
    return q


class _Block(nn.Module):
    def __init__(self, dim, ffn_dim, heads, device, dtype, operations):
        super().__init__()
        self.heads = heads
        self.proj = nn.ModuleDict(
            {
                name: operations.Linear(dim, dim, bias=False, device=device, dtype=dtype)
                for name in ("q", "k", "v", "o")
            }
        )

    def forward(self, x, y, rope, gate_a):
        dtype = self.proj["q"].weight.dtype
        q = self.q_norm(self.proj["q"](y).unflatten(-1, (self.heads, -1))).flatten(2)
        k = self.k_norm(self.proj["k"](y).unflatten(-1, (self.heads, -1))).flatten(2)
        x = x + self.proj["o"](_attention(q, k, self.proj["v"](y), rope, self.heads)) * gate_a[:, None]
        return x.to(dtype)


class Model(nn.Module):
    def __init__(
        self,
        dim=8,
        ffn_dim=16,
        num_heads=2,
        num_layers=2,
        device=None,
        dtype=None,
        operations=None,
        **kwargs,
    ):
        super().__init__()
        self.blocks = nn.ModuleList(
            [_Block(dim, ffn_dim, num_heads, device, dtype, operations) for _ in range(num_layers)]
        )
