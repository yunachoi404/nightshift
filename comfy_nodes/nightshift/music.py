"""YuE2 songs: an instrumental unless the request has sung words.

YuE2 is a song model. Its ABC planner writes a vocal melody even for section-tag lyrics, and YuE2 then sings made-up
words. The authors' instrumental recipe (their yue2-music skill) moves every vocal note to the
instrument part and renders that score with an instrumental style. research/2026-10-31_yue2_music.md measures it.
"""

import logging
import re

from .yue2_score.instrumentalize import convert_score

# Lyrics with only section tags: the planner lays out a song form and nothing is sung.
PLAN_LYRICS = "[Intro]\n\n[Verse]\n\n[Chorus]\n\n[Outro]\n"
CONDITIONS = ("no vocals", "no singing", "no choir", "no spoken words")


def has_words(lyrics):
    """True when the lyrics hold a line to sing, not only [Section] tags."""
    return any(line.strip() and not re.fullmatch(r"\[[^\]]*\]", line.strip()) for line in lyrics.splitlines())


def instrumental_style(style):
    """The skill's render style: "Instrumental, <style>, no vocals, no singing, no choir, no spoken words."."""
    style = style.strip().rstrip(".,") or "Expressive instrumental music"
    if not re.match(r"^instrumental\b", style, re.I):
        style = "Instrumental, " + style
    for condition in CONDITIONS:
        if condition not in style.lower():
            style += ", " + condition
    return style + "."


def section_tags(abc):
    """The score's sections as lyrics, "[Intro]\n\n[Verse]\n", as the skill renders an instrumental."""
    labels = [line[2:] for line in abc.splitlines() if line.startswith("% ")]
    return "\n\n".join("[" + label.title() + "]" for label in labels) + ("\n" if labels else "")


def arrange(plan, style, lyrics):
    """(abc, style, lyrics) for YuE2 Generate Music. YuE2 sings words over the plan as it is. Without words the plan's
    vocal melody moves to the instrument part. A plan the converter refuses falls back to no plan and no lyrics, which
    the lab found mostly instrumental for short songs."""
    if has_words(lyrics):
        return plan, style, lyrics
    try:
        converted, _ = convert_score(plan)
    except Exception as error:  # A converter failure must not cost the user the song.
        logging.warning("YuE2 plan could not be made instrumental (%s); rendering without it", error)
        return "", style, ""
    return converted, instrumental_style(style), section_tags(converted)


class YuE2Instrumental:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "abc": ("STRING", {"forceInput": True}),
                "style": ("STRING", {"forceInput": True}),
                "lyrics": ("STRING", {"forceInput": True}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("abc", "style", "lyrics")
    FUNCTION = "arrange"
    CATEGORY = "Nightshift"
    DESCRIPTION = "Without sung words, moves a YuE2 plan's vocal melody to the instrument part, so the song is an instrumental."

    def arrange(self, abc, style, lyrics):
        return arrange(abc, style, lyrics)
