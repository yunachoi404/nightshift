# The unslop pass

The last polish pass followed the unslop method by Damir Sokolovsky
([@heydamir](https://x.com/heydamir)), [github.com/heydamir/unslop](https://github.com/heydamir/unslop), CC BY 4.0.
It audits a screen against a list of signs, sets a five-line direction, then fixes spacing, color, icons, copy,
type, layout, details, visuals and motion in that order. Nightshift was light slop, so this was a polish pass: the
banana accent, the serif headlines (Young Serif then, Fraunces since the owner's mockups), the dark default, the
layout and the structure all stayed.

## Direction

- **Product.** Short films made on your own GPU: rough drafts by day, the take you picked finished overnight.
- **Character.** Patient, exact, lamp-lit.
- **World.** An edit suite on the night shift. A dark room with a faint ink of night sky, the work under the desk
  light carrying the color, and a sodium street lamp outside that means "done by morning".
- **Moments.** The renders themselves: the Home tiles, the board, the viewer and the timeline. And the overnight
  hand-off, where finals and tonight's queue glow amber.
- **Signature.** The waxing moon: a render's progress is a moon going from new to full, tonight is the moon's arc
  from dusk to dawn, and the mark is a crescent. The amber lamp stays as the color of finals and of the night's work.
  (The first unslop pass had the amber lamp as the signature; the moon pass made the moon the signature.)

## Rules it left behind

- Spacing sits on a 4px grid. Buttons are 32 and 28 tall, sidebar rows 32, board columns 16 apart.
- Dark surfaces carry a faint ink tint; pictures always sit on true black.
- Three text roles: `--text`, `--text-2`, `--text-3`. `--text-4` is for strokes and disabled marks, never words.
- Banana marks the action that makes something, selection on a picture, focus and progress. Chosen tools and
  references are a surface step with a hairline.
- No glows, no colored shadows, no color washes behind content.
- Icons are lucide at a 1.75 stroke: 14px in small controls, 16px in rows and buttons, 18px in tool tabs and the
  toolbar.
- Short strings (labels, buttons, chips, captions, one-line hints, toast lines) end without a period. Help text of
  several sentences keeps its periods.
- Weights 400 and 500. The Generate label keeps 600. No negative tracking under 16px.
- One easing curve, `cubic-bezier(0.22, 1, 0.36, 1)`, 140ms for feedback. Only live work loops: the pulse on a
  running job or a live status, the shimmer on a card that renders. What waits holds still.

## The moon pass

After the unslop pass the owner wanted the night to carry more of the product's meaning. The moon keeps time for the
night shift: a render waxes from new to full, tonight's finals stand on the night's arc under the moon at now, a
final waiting for tonight wears the crescent, and finals finished overnight greet the morning with a dawn. Empty
states draw a night in line art. The palette stays inside the same three colors: night ink for surfaces, moonlight
for the moon, the lamp's amber for finals and the night's work. Banana is still the main action.
