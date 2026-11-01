# YuE2 score tools

`abc_tools.py`, `compile_score.py`, `instrumentalize.py` and `common.py` come from the YuE2 authors' yue2-music skill,
`skills/yue2-music/instrumental/scripts/` at commit
[0495110](https://github.com/multimodal-art-projection/YuE/tree/0495110587a44ed00278929a63cb14a618da8992/skills/yue2-music/instrumental),
under the MIT license in `LICENSE`.

The only change is that their imports of each other are relative, as in `from .abc_tools import ...`, so they load
as part of this node pack.

`NightshiftYuE2Instrumental` (`../music.py`) uses `instrumentalize.convert_score` to move the vocal melody of a
YuE2 plan to the instrument part, the authors' way to make an instrumental with YuE2.
